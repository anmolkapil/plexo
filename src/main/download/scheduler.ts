import type { BlockState, ChunkState } from '../../shared/types'

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

export interface AttemptView {
  kind: 'primary' | 'hedge'
  streamId: number
  networkId: string
  /** When its request was sent. */
  startedAt: number
}

export interface SchedulerState {
  blocks: readonly BlockState[]
  streams: readonly Pick<ChunkState, 'id' | 'interfaceId' | 'status' | 'speedBytesPerSec'>[]
  /** Attempts in flight, by block index. */
  attempts: ReadonlyMap<number, readonly AttemptView[]>
  /** For a block whose last attempt on some network delivered nothing, that network. */
  avoid: ReadonlyMap<number, string>
  /** How many hedges each block has had so far. */
  hedgesUsed: ReadonlyMap<number, number>
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
  block: BlockState
}

/** The first waiting block — except that one whose last attempt on this network delivered
 * nothing is left to another network, for as long as a stream there is free to take it.
 * Otherwise a network that isn't answering would be handed the same block again and again, by
 * whichever of its streams asked first, while healthy networks sat idle beside it. With no other
 * network free the block is taken anyway, so it can never be stranded. */
function nextWaitingBlock(state: SchedulerState, networkId: string): BlockState | undefined {
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

/** The block most worth another attempt: the one that will be longest yet, if the requester
 * would clearly beat it. A block is as slow as its fastest attempt. */
function nextHedgeTarget(
  state: SchedulerState,
  who: Requester,
  now: number,
  policy: SchedulerPolicy
): BlockState | undefined {
  // Only when everything left is already being fetched.
  if (state.blocks.some((block) => block.status === 'pending')) return undefined

  const speedOf = (streamId: number): number =>
    state.streams.find((stream) => stream.id === streamId)?.speedBytesPerSec ?? 0

  let target: BlockState | undefined
  let latest = 0
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.rangeEnd === null || block.status !== 'downloading')
      continue
    // Nothing to race if every attempt let go: the block goes back to the queue instead.
    if (attempts.length === 0 || !attempts.some((attempt) => attempt.kind === 'primary')) continue
    if (attempts.some((attempt) => attempt.streamId === who.id)) continue
    if ((state.hedgesUsed.get(index) ?? 0) >= policy.maxHedgesPerBlock) continue
    // A network that got nothing from this block won't do better on a second try.
    if (state.avoid.get(index) === who.networkId) continue
    // Speeds only mean something once every attempt has been going a while.
    if (attempts.some((attempt) => now - attempt.startedAt < policy.hedgeAfterMs)) continue

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
    const worthIt = who.speedBytesPerSec
      ? eta >= 2 * (policy.startupMs + (remaining / who.speedBytesPerSec) * 1000)
      : eta >= policy.hedgeAfterMs
    if (!worthIt) continue

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
  const slow = nextHedgeTarget(state, who, now, policy)
  return slow && { kind: 'hedge', block: slow }
}
