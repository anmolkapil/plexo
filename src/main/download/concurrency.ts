// How many streams each network runs. Deliberately simple, after Gopeed and aria2: no timers and
// no speed comparisons, so noise on a flaky network can't move it.
//
// - A network starts with START_STREAMS_PER_NETWORK (see reconcile in downloadManager.ts).
// - Once every one of its streams has received data, it doubles, up to the limit. Another
//   connection costs little when the link is already full, and a server that caps each
//   connection's speed is only outrun by more of them.
// - A server that refuses a request (503, 429, 403) is saying it wants fewer connections from
//   this address: the network keeps the streams the server was accepting and never goes above
//   that again for this download.
// - Each network is decided on its own, so one that drops out or comes back never disturbs the
//   others.
//
// No I/O and no clock of its own: it reads a snapshot and says what to do, so every rule can be
// checked against exact situations.

export interface NetworkSnapshot {
  id: string
  /** Its streams, not counting any retiring. */
  streams: number
  /** Its streams that have received data. */
  answered: number
  /** Its streams that have received data and whose last request didn't fail. */
  accepted: number
  /** Requests the server refused on it since the last snapshot. */
  refused: number
}

export interface Snapshot {
  /** The networks in use: the ones it may grow. */
  networks: readonly NetworkSnapshot[]
  /** How many more streams the waiting blocks could keep busy. */
  spareWork: number
}

export type Action = { kind: 'add' | 'retire'; networkId: string; count: number }

export class ConcurrencyController {
  /** The most streams each network may run: lowered for good when its server refuses one. */
  private readonly ceilings = new Map<string, number>()

  constructor(private readonly maxPerNetwork: number) {}

  tick(snapshot: Snapshot): Action[] {
    const actions: Action[] = []
    let spare = snapshot.spareWork
    for (const network of snapshot.networks) {
      const { id, streams } = network
      if (network.refused > 0) {
        const ceiling = Math.max(1, Math.min(streams, network.accepted))
        this.ceilings.set(id, Math.min(ceiling, this.ceilings.get(id) ?? Infinity))
      }
      const ceiling = Math.min(this.maxPerNetwork, this.ceilings.get(id) ?? Infinity)
      if (streams > ceiling) {
        actions.push({ kind: 'retire', networkId: id, count: streams - ceiling })
        continue
      }
      if (streams === 0 || network.answered < streams) continue
      const count = Math.min(streams, ceiling - streams, spare)
      if (count < 1) continue
      spare -= count
      actions.push({ kind: 'add', networkId: id, count })
    }
    return actions
  }
}
