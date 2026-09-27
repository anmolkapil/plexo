// How many streams each network runs. Deliberately simple, after Gopeed and aria2: no timers and
// no speed comparisons, so noise on a flaky network can't move it.
//
// - A network starts with START_STREAMS_PER_NETWORK (see reconcile in downloadManager.ts), or
//   with the count the user picked, which it then keeps rather than grows.
// - Once every one of its streams has received data, it doubles, up to the limit. Another
//   connection costs little when the link is already full, and a server that caps each
//   connection's speed is only outrun by more of them.
// - A server that refuses some of a network's streams (503, 429, 403, or leaves them unanswered
//   for SILENT_AFTER_MS, see downloadManager.ts) while it is sending data down others is saying
//   it wants fewer connections from this address: the refused streams close, and the network
//   stays at the ones left. After RECOVER_MS without another refusal it may have one more, and
//   so on back up to the limit, as in Surge: a server that was only briefly unwell doesn't cap
//   the rest of a long download, and one that meant it costs one refused request a minute. Only
//   the streams refused count against it: one that failed some other way, or hasn't been
//   answered yet, isn't a refusal. As in Gopeed, where a refused connection stops and the others
//   carry on.
// - A server that refuses while sending nothing isn't limiting connections: it is busy, or the
//   link has expired or been denied. That is waited out or reported elsewhere (see finishFailed
//   in downloadManager.ts), and the count stays. The network doesn't grow meanwhile.
// - Each network is decided on its own, so one that drops out or comes back never disturbs the
//   others.
//
// No I/O and no clock of its own: it reads a snapshot, time included, and says what to do, so
// every rule can be checked against exact situations.

/** How long a lowered limit holds before it may rise by one. */
export const RECOVER_MS = 60_000

export interface NetworkSnapshot {
  id: string
  /** Its streams, not counting any retiring. */
  streams: number
  /** Its streams that have received data. */
  answered: number
  /** Its streams the server refused a request from since the last snapshot. */
  refused: number
  /** Its streams that received data since the last snapshot. */
  served: number
}

export interface Snapshot {
  now: number
  /** The networks in use: the ones it may grow. */
  networks: readonly NetworkSnapshot[]
  /** How many more streams the waiting blocks could keep busy. */
  spareWork: number
}

export type Action = { kind: 'add' | 'retire'; networkId: string; count: number }

export class ConcurrencyController {
  /** Networks a server has refused on: the most streams each may run for now, and when that was
   * last changed. */
  private readonly ceilings = new Map<string, { limit: number; since: number }>()

  constructor(
    /** The most streams a network may run. */
    private readonly maxPerNetwork: number,
    /** false: keep each network at maxPerNetwork (the user's pick) rather than doubling to it. */
    private readonly grows = true
  ) {}

  tick(snapshot: Snapshot): Action[] {
    const actions: Action[] = []
    const { now } = snapshot
    let spare = snapshot.spareWork
    for (const network of snapshot.networks) {
      const { id, streams } = network
      const refusedNow = network.refused > 0 && network.served > 0
      let entry = this.ceilings.get(id)
      if (refusedNow) {
        const limit = Math.max(1, Math.min(streams - network.refused, entry?.limit ?? Infinity))
        this.ceilings.set(id, (entry = { limit, since: now }))
      } else if (entry && network.refused === 0 && now - entry.since >= RECOVER_MS) {
        entry.limit++
        entry.since = now
        if (entry.limit >= this.maxPerNetwork) {
          this.ceilings.delete(id)
          entry = undefined
        }
      }
      const ceiling = Math.min(this.maxPerNetwork, entry?.limit ?? Infinity)
      if (streams > ceiling) {
        actions.push({ kind: 'retire', networkId: id, count: streams - ceiling })
        continue
      }
      // Not while the server is turning requests away.
      if (network.refused > 0 || streams === 0 || network.answered < streams) continue
      const count = Math.min(this.grows ? streams : Infinity, ceiling - streams, spare)
      if (count < 1) continue
      spare -= count
      actions.push({ kind: 'add', networkId: id, count })
    }
    return actions
  }
}
