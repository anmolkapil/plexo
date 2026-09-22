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
//            finishes first wins; the other is dropped.

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
  /** A block is hedged once its holder has been at it this long and still needs at least as long
   * again. Long enough to have measured a real speed, and far more than a new connection costs. */
  hedgeAfterMs: number
  /** Bounds the duplicate work on a block whose hedges keep failing. */
  maxHedgesPerBlock: number
}

export interface Requester {
  id: number
  networkId: string
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

/** The block most worth a second attempt: the one whose holder will be longest yet. */
function nextHedgeTarget(
  state: SchedulerState,
  who: Requester,
  now: number,
  policy: SchedulerPolicy
): BlockState | undefined {
  // Only when everything left is already being fetched.
  if (state.blocks.some((block) => block.status === 'pending')) return undefined

  let target: BlockState | undefined
  let latest = 0
  for (const [index, attempts] of state.attempts) {
    const block = state.blocks[index]
    if (block?.index !== index || block.rangeEnd === null || block.status !== 'downloading')
      continue
    // Lone primary only: one hedge at a time, and nothing to race if the holder let go.
    if (attempts.length !== 1 || attempts[0].kind !== 'primary') continue
    const holder = attempts[0]

    if (holder.streamId === who.id) continue
    if ((state.hedgesUsed.get(index) ?? 0) >= policy.maxHedgesPerBlock) continue
    // A network that got nothing from this block won't do better on a second try.
    if (state.avoid.get(index) === who.networkId) continue
    if (now - holder.startedAt < policy.hedgeAfterMs) continue

    const remaining = block.rangeEnd - block.rangeStart + 1 - block.bytesDownloaded
    if (remaining <= 0) continue
    const speed = state.streams.find((stream) => stream.id === holder.streamId)?.speedBytesPerSec
    // A holder that has gone quiet has no finish time at all.
    const eta = speed ? (remaining / speed) * 1000 : Infinity
    if (eta < policy.hedgeAfterMs) continue

    // The holder's network may be what is slow, so a stream on another network gets the first
    // go — unless none of those would take it either.
    const otherNetworkFree = state.streams.some(
      (stream) =>
        stream.interfaceId !== holder.networkId &&
        stream.status === 'pending' &&
        state.avoid.get(index) !== stream.interfaceId
    )
    if (holder.networkId === who.networkId && otherNetworkFree) continue

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
