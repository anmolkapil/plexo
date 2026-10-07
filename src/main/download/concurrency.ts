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
// - A disk that can't keep up holds each stream's reading until its writes catch up. Streams
//   writing to scattered places are what slow a hard drive down, so once most of the download's
//   streams have been held up for DISK_PATIENCE_TICKS in a row, every network halves, and none
//   grows or recovers while that lasts; each DISK_RECOVER_MS the disk keeps up, each may double
//   again. A busy disk passes, and a server that caps each connection's speed needs its streams
//   back quickly. The disk is decided for the whole download, not per network: a stream only
//   fills its writer when it receives fast, so a fast network would read as held and a slow one
//   wouldn't, and the fast one alone would be cut while the slow one's streams kept writing all
//   over the disk. Held only counts while writes are still landing: a disk that has stopped
//   altogether (another program, a drive waking up) is waited out, as fewer streams wouldn't
//   help it. A download the disk keeps up with is never held, so this costs nothing anywhere
//   else. The user's own pick is kept, as it is for everything but refusals.
// - Otherwise each network is decided on its own, so one that drops out or comes back never
//   disturbs the others.
//
// No I/O and no clock of its own: it reads a snapshot, time included, and says what to do, so
// every rule can be checked against exact situations.

/** How long a lowered limit holds before it may rise by one. */
export const RECOVER_MS = 60_000
/** Snapshots in a row the download's streams must mostly wait on the disk before they halve. */
export const DISK_PATIENCE_TICKS = 2
/** How long a limit the disk set holds before it may double. */
export const DISK_RECOVER_MS = 10_000

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
  /** Its streams whose reading is held up for the disk right now, while the download's writes are
   * landing. */
  held?: number
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
  private readonly ceilings = new Map<string, { limit: number; since: number; byDisk?: boolean }>()
  /** For how many snapshots in a row most of the download's streams have waited on the disk. */
  private diskBound = 0

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
    let streamsNow = 0
    let heldNow = 0
    for (const network of snapshot.networks) {
      streamsNow += network.streams
      heldNow += network.held ?? 0
    }
    const held = this.grows && heldNow * 2 > streamsNow
    this.diskBound = held ? this.diskBound + 1 : 0
    const halve = this.diskBound >= DISK_PATIENCE_TICKS
    if (halve) this.diskBound = 0
    for (const network of snapshot.networks) {
      const { id, streams } = network
      const refusedNow = network.refused > 0 && network.served > 0
      let entry = this.ceilings.get(id)
      if (halve && streams > 1) {
        const limit = Math.min(Math.ceil(streams / 2), entry?.limit ?? Infinity)
        // A limit a server's refusal set recovers as a refusal's does.
        this.ceilings.set(id, (entry = { limit, since: now, byDisk: entry ? entry.byDisk : true }))
      } else if (refusedNow) {
        const limit = Math.max(1, Math.min(streams - network.refused, entry?.limit ?? Infinity))
        this.ceilings.set(id, (entry = { limit, since: now }))
      } else if (
        entry &&
        network.refused === 0 &&
        !held &&
        now - entry.since >= (entry.byDisk ? DISK_RECOVER_MS : RECOVER_MS)
      ) {
        entry.limit = entry.byDisk ? entry.limit * 2 : entry.limit + 1
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
      if (network.refused > 0 || held || streams === 0 || network.answered < streams) continue
      const count = Math.min(this.grows ? streams : Infinity, ceiling - streams, spare)
      if (count < 1) continue
      spare -= count
      actions.push({ kind: 'add', networkId: id, count })
    }
    return actions
  }
}
