import type { HttpBlockState, HttpStreamState } from '../../shared/types'

// Who should fetch what, decided from a snapshot of the download and nothing else — no I/O, no
// clock of its own — so every rule here can be checked against exact situations.
//
// A free stream is given one of two kinds of work:
//
//   primary  A block nobody is fetching. The normal case, and the only one until the queue runs dry.
//   hedge    A second attempt at a block someone else is fetching too slowly. Only handed out once
//            no block is left waiting, so it can never take bandwidth from work that still needs
//            doing: what a hedge costs is bytes fetched twice at the very end, and what it buys is
//            that one slow connection can no longer hold the whole download back. Whichever attempt
//            finishes first wins; the others are dropped. It is handed out as soon as it would
//            clearly finish first, and a block whose hedge is stuck too can be raced again.
//   split    A hedge that starts partway into what an attempt has left, rather than where it has
//            got to, as download managers split the largest remaining range when a connection
//            frees up (IDM, aria2). For when racing wouldn't pay: the free stream is no faster
//            than the holder, as when a server caps each connection, so a duplicate would only
//            fetch the same bytes as slowly. Each fetches its own part and the block is done
//            when they meet, so the free streams at the end of a download share its last blocks
//            instead of watching one connection crawl through each. Only while both networks
//            have room to spare (see hasSpare): on a network that is already full, the holder
//            speeds up by itself as the others finish, and a split would only take from them.

export interface AttemptView {
  kind: 'primary' | 'hedge'
  streamId: number
  networkId: string
  /** When its request was sent. */
  startedAt: number
  /** The reader is paused for writes or its body ended and the writer is flushing: the disk, not
   * the connection, sets its pace. */
  writeWaiting?: boolean
  /** Where its request begins, as an offset into the block (null until known), and how much it
   * has received from there. Without them, its block is never split. */
  startOffset?: number | null
  received?: number
}

/** A network's speed now and the best it has held lately. */
export interface NetworkLoad {
  speedBytesPerSec: number
  peakBytesPerSec: number
}

/** Bytes of a block fetched ahead of where its first byte has got to (by a split), as offsets
 * into the block: [start, end). */
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
  /** By block index, what splits have fetched there that isn't joined to the block's start yet. */
  segments?: ReadonlyMap<number, readonly Segment[]>
  /** By network id, how it is doing (see hasSpare). Without it, blocks are never split. */
  networks?: ReadonlyMap<string, NetworkLoad>
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
  /** The least a split hands either side; absent, blocks are never split. Each part is its own
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
  kind: 'primary' | 'hedge'
  block: HttpBlockState
  /** For a split: where in the block the hedge starts, rather than where the block has got to. */
  startOffset?: number
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

// A network running under this share of the best it has held lately has room for more requests.
// Clearly under: a full network wobbles a little below its peak, and a split there would only take
// from its other streams.
const SPARE_SHARE = 0.85

/** Whether a network has room for another request: it runs well under the best it has held
 * lately, as when a server caps each connection and the streams that freed up took their share
 * with them. A network that is full instead speeds up its remaining streams as others finish.
 * Not known, it hasn't. */
function hasSpare(state: SchedulerState, networkId: string): boolean {
  const load = state.networks?.get(networkId)
  return (
    !!load && load.peakBytesPerSec > 0 && load.speedBytesPerSec < SPARE_SHARE * load.peakBytesPerSec
  )
}

/** Where in `block` a split by `who` would start, and how long the block would take without it,
 * if splitting would clearly finish it sooner. The part split is the end of what the slowest
 * attempt has left: from where it has got to up to where the next attempt or segment begins.
 * Each side gets a share in proportion to its speed, so both finish together. */
function splitPoint(
  state: SchedulerState,
  block: HttpBlockState,
  attempts: readonly AttemptView[],
  who: Requester,
  policy: SchedulerPolicy,
  speedOf: (streamId: number) => number
): { startOffset: number; eta: number } | undefined {
  const minBytes = policy.minSplitBytes
  const mine = who.speedBytesPerSec
  if (!minBytes || !mine || block.rangeEnd === null) return undefined
  // Only bandwidth that would otherwise go unused makes a split worth it.
  if (!hasSpare(state, who.networkId)) return undefined
  const length = block.rangeEnd - block.rangeStart + 1
  const starts = [
    ...attempts.map((attempt) => attempt.startOffset ?? null),
    ...(state.segments?.get(block.index) ?? []).map((segment) => segment.start)
  ]
  if (starts.includes(null)) return undefined

  let slowest:
    { from: number; to: number; speed: number; eta: number; networkId: string } | undefined
  for (const attempt of attempts) {
    const speed = speedOf(attempt.streamId)
    if (!speed || attempt.received === undefined) return undefined
    const from = Math.max(attempt.startOffset! + attempt.received, block.bytesDownloaded)
    const to = Math.min(length, ...starts.filter((start) => start! > from).map((start) => start!))
    const eta = ((to - from) / speed) * 1000
    if (to > from && (!slowest || eta > slowest.eta))
      slowest = { from, to, speed, eta, networkId: attempt.networkId }
  }
  if (!slowest || slowest.eta < policy.hedgeAfterMs) return undefined
  // A holder on a full network gets faster as its neighbours finish, and would run on past the
  // split into bytes the split is fetching too.
  if (!hasSpare(state, slowest.networkId)) return undefined

  const share = Math.floor(((slowest.to - slowest.from) * mine) / (slowest.speed + mine))
  if (share < minBytes || slowest.to - slowest.from - share < minBytes) return undefined
  const after = Math.max(
    policy.startupMs + (share / mine) * 1000,
    ((slowest.to - slowest.from - share) / slowest.speed) * 1000
  )
  // Worth a request only if the block is done a good while sooner.
  if (after * 1.25 > slowest.eta) return undefined
  return { startOffset: slowest.to - share, eta: slowest.eta }
}

/** The block most worth another attempt: the one that will be longest yet, if the requester
 * would clearly beat it — or, failing that, if splitting it would (see splitPoint). A block is
 * as slow as its fastest attempt. */
function nextHedgeTarget(
  state: SchedulerState,
  who: Requester,
  now: number,
  policy: SchedulerPolicy
): Work | undefined {
  // Only when everything left is already being fetched, and the disk has room for more writes.
  if (state.diskBehind || state.blocks.some((block) => block.status === 'pending')) return undefined

  const speedOf = (streamId: number): number =>
    state.streams.find((stream) => stream.id === streamId)?.speedBytesPerSec ?? 0

  let target: Work | undefined
  let latest = 0
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.rangeEnd === null || block.status !== 'downloading')
      continue
    // Nothing to race if every attempt let go: the block goes back to the queue instead.
    if (attempts.length === 0 || !attempts.some((attempt) => attempt.kind === 'primary')) continue
    if (attempts.some((attempt) => attempt.streamId === who.id)) continue
    // Two hedges at a time at most, splits included.
    if (attempts.filter((attempt) => attempt.kind === 'hedge').length >= policy.maxHedgesPerBlock)
      continue
    // A network that got nothing from this block won't do better on a second try.
    if (state.avoid.get(index) === who.networkId) continue
    // Speeds only mean something once every attempt has been going a while.
    if (attempts.some((attempt) => now - attempt.startedAt < policy.hedgeAfterMs)) continue
    // A holder waiting on its writer is as slow as the disk, which another attempt can't beat.
    if (attempts.some((attempt) => attempt.writeWaiting)) continue

    const remaining = block.rangeEnd - block.rangeStart + 1 - block.bytesDownloaded
    if (remaining <= 0) continue
    // A holder that has gone quiet has no finish time at all.
    const eta = Math.min(
      ...attempts.map((attempt) => {
        const speed = speedOf(attempt.streamId)
        return speed ? (remaining / speed) * 1000 : Infinity
      })
    )
    // Worth it only if the requester would finish in under half that time. One whose speed isn't
    // known yet races a block that needs at least hedgeAfterMs more.
    const worthIt =
      (state.hedgesUsed.get(index) ?? 0) < policy.maxHedgesPerBlock &&
      (who.speedBytesPerSec
        ? eta >= 2 * (policy.startupMs + (remaining / who.speedBytesPerSec) * 1000)
        : eta >= policy.hedgeAfterMs)
    // Racing wouldn't pay: maybe splitting would.
    const split = worthIt ? undefined : splitPoint(state, block, attempts, who, policy, speedOf)
    if (!worthIt && !split) continue

    // The holders' network may be what is slow, so a stream on another network gets the first
    // go — unless none of those would take it either.
    const holders = new Set(attempts.map((attempt) => attempt.networkId))
    const otherNetworkFree = state.streams.some(
      (stream) =>
        !holders.has(stream.interfaceId) &&
        stream.status === 'pending' &&
        state.avoid.get(index) !== stream.interfaceId
    )
    if (holders.has(who.networkId) && otherNetworkFree) continue

    const finish = split ? split.eta : eta
    if (finish > latest) {
      target = split
        ? { kind: 'hedge', block, startOffset: split.startOffset }
        : { kind: 'hedge', block }
      latest = finish
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
  return nextHedgeTarget(state, who, now, policy)
}
