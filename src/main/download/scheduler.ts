import type { HttpBlockState, HttpStreamState } from '../../shared/types'

// Who should fetch what, decided from a snapshot of the download and nothing else — no I/O, no
// clock of its own — so every rule here can be checked against exact situations.
//
// A free stream is given one of three kinds of work:
//
//   primary  A block nobody is fetching. The normal case, and the only one until the queue runs dry.
//   hedge    A second attempt at a block someone else is fetching too slowly. Only handed out once
//            no block is left waiting, so it can never take bandwidth from work that still needs
//            doing: what a hedge costs is bytes fetched twice at the very end, and what it buys is
//            that one slow connection can no longer hold the whole download back. Whichever attempt
//            finishes first wins; the others are dropped. It is handed out as soon as it would
//            clearly finish first, and a block whose hedge is stuck too can be raced again.
//   split    The back half of what an attempt has left, once no block is waiting and racing
//            wouldn't pay. The attempt stops where the split begins, so nothing is fetched twice,
//            and the free streams at the end of a download share its last blocks rather than
//            watching one connection each crawl through them. No speeds come into it: the part
//            with the most bytes left is halved, for as long as both halves stay over
//            minSplitBytes.
//
// Splits live only in memory, as parts of a block. A block's progress is still its frontier: the
// bytes from its first one that are in (see blockProgress.ts). A split's bytes count once the
// frontier reaches them, so saved progress is unchanged, and a pause or a crash only means
// fetching them again.

export interface AttemptView {
  kind: 'primary' | 'hedge' | 'split'
  streamId: number
  networkId: string
  /** When its request was sent. */
  startedAt: number
  /** The reader is paused for writes or its body ended and the writer is flushing: the disk, not
   * the connection, sets its pace. */
  writeWaiting?: boolean
  /** Its part of the block, as offsets into it: from startOffset up to end, exclusive. Null
   * when not known (a block of unknown length); without them, its part is never split. */
  startOffset?: number | null
  end?: number | null
  /** Bytes it has been sent from startOffset: past these, its part can still be cut short. */
  networkReceived?: number
  /** Called off and on its way out: its part is not split. */
  abortReason?: string | null
}

/** Bytes of a block fetched ahead of its frontier by a split that has finished or stopped, as
 * offsets into the block: [start, end). */
export interface Segment {
  start: number
  end: number
}

export interface SchedulerState {
  blocks: readonly HttpBlockState[]
  streams: readonly Pick<HttpStreamState, 'id' | 'interfaceId' | 'status' | 'speedBytesPerSec'>[]
  /** Attempts in flight, by block index. */
  attempts: ReadonlyMap<number, readonly AttemptView[]>
  /** For a block whose last attempt on some network delivered nothing, that network. */
  avoid: ReadonlyMap<number, string>
  /** How many hedges each block has had so far. */
  hedgesUsed: ReadonlyMap<number, number>
  /** The disk can't keep up (see DiskWatch in concurrency.ts): a hedge would only add writes. */
  diskBehind?: boolean
  /** By block index, what splits have fetched ahead of its frontier. */
  segments?: ReadonlyMap<number, readonly Segment[]>
}

export interface SchedulerPolicy {
  /** A block is only raced once every attempt at it has been going this long: long enough to
   * have measured a real speed. */
  hedgeAfterMs: number
  /** Bounds the duplicate work on a block whose hedges keep failing. */
  maxHedgesPerBlock: number
  /** What a new request costs before its first byte arrives (connecting, the server answering),
   * counted into how long a hedge would take. */
  startupMs: number
  /** The least either half of a split may be; absent, nothing is split. Each part is its own
   * request, so below this the round trip costs more than the split saves. */
  minSplitBytes?: number
}

export interface Requester {
  id: number
  networkId: string
  /** How fast this stream fetched its last block, if it has finished one. Without it, a block is
   * only raced once its attempts need hedgeAfterMs more. */
  speedBytesPerSec?: number
}

export interface Work {
  kind: 'primary' | 'hedge' | 'split'
  block: HttpBlockState
  /** For a split: its part of the block, as offsets into it, [start, end). Whoever is fetching
   * across `start` stops there. */
  start?: number
  end?: number
}

const lengthOf = (block: HttpBlockState): number | null =>
  block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1

/** Where an attempt starting `from` bytes into `block` stops: where the next part someone is
 * fetching, or has fetched, begins — or the end of the block. Null for a block of unknown length. */
export function partEnd(
  block: HttpBlockState,
  attempts: readonly AttemptView[],
  segments: readonly Segment[],
  from: number
): number | null {
  let end = lengthOf(block)
  if (end === null) return null
  for (const attempt of attempts) {
    if (attempt.startOffset != null && attempt.startOffset > from)
      end = Math.min(end, attempt.startOffset)
  }
  for (const segment of segments) if (segment.start > from) end = Math.min(end, segment.start)
  return end
}

/** The first stretch of `block`, past its frontier, that nobody is fetching and nobody has: what
 * a split left behind when it stopped early. */
function firstGap(
  block: HttpBlockState,
  attempts: readonly AttemptView[],
  segments: readonly Segment[]
): Segment | undefined {
  const length = lengthOf(block)
  if (length === null) return undefined
  const taken: Segment[] = [{ start: 0, end: block.bytesDownloaded }, ...segments]
  for (const attempt of attempts) {
    if (attempt.startOffset == null) return undefined
    taken.push({ start: attempt.startOffset, end: attempt.end ?? length })
  }
  taken.sort((a, b) => a.start - b.start)
  let reach = 0
  for (const part of taken) {
    if (part.start > reach) break
    reach = Math.max(reach, part.end)
  }
  if (reach >= length) return undefined
  const next = taken.find((part) => part.start > reach)
  return { start: reach, end: next ? next.start : length }
}

/** The first waiting block — except that one whose last attempt on this network delivered
 * nothing is left to another network, for as long as a stream there is free to take it.
 * Otherwise a network that isn't answering would be handed the same block again and again, by
 * whichever of its streams asked first, while healthy networks sat idle beside it. With no other
 * network free the block is taken anyway, so it can never be stranded. */
function nextWaitingBlock(state: SchedulerState, networkId: string): HttpBlockState | undefined {
  // A pending stream is one waiting for work (see ChunkStatus).
  const otherNetworkFree = state.streams.some(
    (stream) => stream.interfaceId !== networkId && stream.status === 'pending'
  )
  return state.blocks.find(
    (block) =>
      block.status === 'pending' &&
      !(otherNetworkFree && state.avoid.get(block.index) === networkId)
  )
}

/** A stretch of a block in flight that nobody is fetching, past its frontier. Taken like a
 * waiting block, and left to another network by one that got nothing from the block. */
function nextGap(state: SchedulerState, networkId: string): Work | undefined {
  const otherNetworkFree = state.streams.some(
    (stream) => stream.interfaceId !== networkId && stream.status === 'pending'
  )
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.status !== 'downloading') continue
    if (otherNetworkFree && state.avoid.get(index) === networkId) continue
    // Only behind someone fetching from the frontier: without one, the block goes back to the
    // queue and is taken from there.
    if (!attempts.some((attempt) => attempt.kind === 'primary')) continue
    const gap = firstGap(block, attempts, state.segments?.get(index) ?? [])
    if (gap && gap.start > block.bytesDownloaded) {
      return { kind: 'split', block, start: gap.start, end: gap.end }
    }
  }
  return undefined
}

/** The back half of the part with the most bytes left, if both halves are at least
 * minSplitBytes. Only once nothing is waiting, and while the disk keeps up. A part being raced
 * is left whole: both racers would have to be cut short. */
function nextSplit(
  state: SchedulerState,
  who: Requester,
  policy: SchedulerPolicy
): Work | undefined {
  const min = policy.minSplitBytes
  if (!min || state.diskBehind || state.blocks.some((block) => block.status === 'pending'))
    return undefined

  let target: Work | undefined
  let most = 2 * min - 1
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.rangeEnd === null || block.status !== 'downloading')
      continue
    // A network that got nothing from this block won't do better on a part of it.
    if (state.avoid.get(index) === who.networkId) continue
    const raced = attempts.some((attempt) => attempt.kind === 'hedge')
    for (const attempt of attempts) {
      if (attempt.abortReason || (raced && attempt.kind !== 'split')) continue
      const { startOffset, end, networkReceived } = attempt
      if (startOffset == null || end == null || networkReceived === undefined) continue
      const reached = startOffset + networkReceived
      const left = end - reached
      if (left > most) {
        most = left
        target = { kind: 'split', block, start: reached + Math.floor(left / 2), end }
      }
    }
  }
  return target
}

/** The block most worth another attempt: the one that will be longest yet, if the requester
 * would clearly beat it. A block is as slow as its fastest attempt. */
function nextHedgeTarget(
  state: SchedulerState,
  who: Requester,
  now: number,
  policy: SchedulerPolicy
): HttpBlockState | undefined {
  // Only when everything left is already being fetched, and the disk has room for more writes.
  if (state.diskBehind || state.blocks.some((block) => block.status === 'pending')) return undefined

  const speedOf = (streamId: number): number =>
    state.streams.find((stream) => stream.id === streamId)?.speedBytesPerSec ?? 0

  let target: HttpBlockState | undefined
  let latest = 0
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.rangeEnd === null || block.status !== 'downloading')
      continue
    if (attempts.some((attempt) => attempt.streamId === who.id)) continue
    // What is raced is the part fetched from the block's frontier; any split ahead of it goes on
    // by itself.
    const racing = attempts.filter((attempt) => attempt.kind !== 'split')
    const primary = racing.find((attempt) => attempt.kind === 'primary')
    // Nothing to race if every attempt let go: the block goes back to the queue instead.
    if (!primary) continue
    if ((state.hedgesUsed.get(index) ?? 0) >= policy.maxHedgesPerBlock) continue
    // A network that got nothing from this block won't do better on a second try.
    if (state.avoid.get(index) === who.networkId) continue
    // Speeds only mean something once every attempt has been going a while.
    if (racing.some((attempt) => now - attempt.startedAt < policy.hedgeAfterMs)) continue
    // A holder waiting on its writer is as slow as the disk, which another attempt can't beat.
    if (racing.some((attempt) => attempt.writeWaiting)) continue

    const remaining = (primary.end ?? block.rangeEnd - block.rangeStart + 1) - block.bytesDownloaded
    if (remaining <= 0) continue
    // A holder that has gone quiet has no finish time at all.
    const eta = Math.min(
      ...racing.map((attempt) => {
        const speed = speedOf(attempt.streamId)
        return speed ? (remaining / speed) * 1000 : Infinity
      })
    )
    // Worth it only if the requester would finish in under half that time. One whose speed isn't
    // known yet races a block that needs at least hedgeAfterMs more.
    const worthIt = who.speedBytesPerSec
      ? eta >= 2 * (policy.startupMs + (remaining / who.speedBytesPerSec) * 1000)
      : eta >= policy.hedgeAfterMs
    if (!worthIt) continue

    // The holders' network may be what is slow, so a stream on another network gets the first
    // go — unless none of those would take it either.
    const holders = new Set(racing.map((attempt) => attempt.networkId))
    const otherNetworkFree = state.streams.some(
      (stream) =>
        !holders.has(stream.interfaceId) &&
        stream.status === 'pending' &&
        state.avoid.get(index) !== stream.interfaceId
    )
    if (holders.has(who.networkId) && otherNetworkFree) continue

    if (eta > latest) {
      target = block
      latest = eta
    }
  }
  return target
}

export function pickWork(
  state: SchedulerState,
  who: Requester,
  now: number,
  policy: SchedulerPolicy
): Work | undefined {
  const waiting = nextWaitingBlock(state, who.networkId)
  if (waiting) return { kind: 'primary', block: waiting }
  const gap = nextGap(state, who.networkId)
  if (gap) return gap
  const slow = nextHedgeTarget(state, who, now, policy)
  if (slow) return { kind: 'hedge', block: slow }
  return nextSplit(state, who, policy)
}
