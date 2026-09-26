// How many streams each network runs, decided while the download runs from what it measures.
//
// Another connection only helps when something limits each connection on its own — a server
// that caps a connection's speed, or TCP on a long or lossy path — and not once the network
// itself is full. Nothing outside says which, so the controller finds out the one way it can:
// it adds streams to a network and keeps them if the download got faster.
//
// - Speeds are only compared once they have settled: a measurement is taken window after window
//   until no network is still speeding up. New connections ramp up, and a speed caught halfway
//   would make whatever comes next look like a gain.
// - One network at a time, doubling its streams (4 → 8 → 16): the answer in a couple of steps.
// - A step is kept when it made the download faster by at least `minGain` of that network's
//   speed before it: the network's own gain, less what the other networks lost. Their loss only
//   counts once it is more than `minGain` of their own speed — that much is beyond their
//   everyday noise — so a slow link's real gain isn't lost in a fast one's ups and downs, while
//   streams that only take speed from a network behind the same uplink still gain nothing.
// - A step that doesn't pay is undone and that network grows no further. So is one whose new
//   streams are turned away: failing before they receive anything is how a server says it wants
//   fewer connections.
// - Networks join and leave while a download runs. Speeds measured before say nothing about
//   the networks there are now, so a step under way is then undone unjudged and measuring starts
//   over; a network that joins (or comes back) is new to it, whatever was found out before.
//
// No I/O and no clock of its own: it reads a snapshot and says what to do, so every rule can be
// checked against exact situations.

export interface NetworkSnapshot {
  id: string
  /** Its streams, not counting any retiring. */
  streams: number
  /** Everything its streams have received, ever. */
  received: number
  /** Its streams that have failed without ever receiving anything. */
  rejected: number
}

export interface Snapshot {
  now: number
  /** The networks in use: the ones it may grow. */
  networks: readonly NetworkSnapshot[]
  /** How many more streams the waiting blocks could keep busy. */
  spareWork: number
  /** Streams on their way out after a step that didn't pay. */
  retiring: number
}

export type Action = { kind: 'add' | 'retire'; networkId: string; count: number }

export interface ConcurrencyPolicy {
  maxPerNetwork: number
  /** How long each measurement window runs. */
  windowMs: number
  /** How long streams get to connect before they're measured at all. */
  warmupMs: number
  /** The least a step must gain, as a share of its network's speed before it. */
  minGain: number
  /** Windows a measurement may take to settle before it is taken as it stands. */
  maxWindows: number
}

/** Bytes per second, by network id. */
type Rates = Map<string, number>

/** Measuring window after window until the speeds settle. */
interface Measurement {
  /** Nothing is measured before this. */
  startAt: number
  /** Where the current window began, once it has. */
  from: { at: number; received: Map<string, number> } | null
  /** The last window's speeds. */
  last: Rates | null
  windows: number
}

type Phase =
  /** Measuring the streams as they are. */
  | { kind: 'measure'; measurement: Measurement }
  /** Streams were just added to `networkId`; measuring whether they paid. */
  | {
      kind: 'trial'
      networkId: string
      added: number
      before: Rates
      rejectedBefore: number
      measurement: Measurement
    }
  /** No network can grow any more. */
  | { kind: 'done' }

const sum = (rates: Rates, include: (id: string) => boolean): number => {
  let total = 0
  for (const [id, rate] of rates) if (include(id)) total += rate
  return total
}

export class ConcurrencyController {
  private phase: Phase | null = null
  /** Networks that grow no further. */
  private readonly settled = new Set<string>()
  /** Where the next look for a network to grow starts, so each gets its turn. */
  private next = 0
  /** The networks the last tick saw. */
  private members: Set<string> | null = null

  constructor(private readonly policy: ConcurrencyPolicy) {}

  tick(snapshot: Snapshot): Action | undefined {
    const known = this.members
    const members = (this.members = new Set(snapshot.networks.map((network) => network.id)))
    if (known && (known.size !== members.size || [...members].some((id) => !known.has(id)))) {
      return this.regroup(snapshot, known)
    }

    const phase = (this.phase ??= { kind: 'measure', measurement: this.measurement(snapshot) })
    switch (phase.kind) {
      case 'measure': {
        // Streams on their way out would count towards a speed that's about to drop.
        if (snapshot.retiring > 0) {
          phase.measurement = this.measurement(snapshot)
          return undefined
        }
        const rates = this.measure(phase.measurement, snapshot)
        return rates && this.grow(snapshot, rates)
      }

      case 'trial': {
        const network = snapshot.networks.find((entry) => entry.id === phase.networkId)
        if (!network || network.rejected > phase.rejectedBefore) return this.undo(snapshot, phase)
        const after = this.measure(phase.measurement, snapshot)
        if (!after) return undefined
        const { minGain } = this.policy
        const own = phase.networkId
        const ownBefore = phase.before.get(own) ?? 0
        const othersBefore = sum(phase.before, (id) => id !== own)
        const othersLoss = othersBefore - sum(after, (id) => id !== own)
        const loss = othersLoss > minGain * othersBefore ? othersLoss : 0
        if ((after.get(own) ?? 0) - ownBefore - loss < minGain * ownBefore) {
          return this.undo(snapshot, phase)
        }
        // Kept, and measured settled: that is where the next step starts from.
        return this.grow(snapshot, after)
      }

      case 'done':
        return undefined
    }
  }

  /** The download stopped (a pause): streams whose step was never judged are to go, and
   * measuring starts over when it runs again. What was settled stays settled. */
  interrupt(): Action | undefined {
    const phase = this.phase
    this.phase = phase?.kind === 'done' ? phase : null
    return phase?.kind === 'trial'
      ? { kind: 'retire', networkId: phase.networkId, count: phase.added }
      : undefined
  }

  /** Networks joined or left: see the top of this file. */
  private regroup(snapshot: Snapshot, known: Set<string>): Action | undefined {
    for (const { id } of snapshot.networks) if (!known.has(id)) this.settled.delete(id)
    const phase = this.phase
    this.phase = { kind: 'measure', measurement: this.measurement(snapshot) }
    return phase?.kind === 'trial'
      ? { kind: 'retire', networkId: phase.networkId, count: phase.added }
      : undefined
  }

  private measurement(snapshot: Snapshot): Measurement {
    return { startAt: snapshot.now + this.policy.warmupMs, from: null, last: null, windows: 0 }
  }

  /** Advances a measurement; its speeds once they have settled, or once it has run out of
   * windows to settle in. */
  private measure(measurement: Measurement, { now, networks }: Snapshot): Rates | undefined {
    if (now < measurement.startAt) return undefined
    const received = new Map(networks.map((network) => [network.id, network.received]))
    const { from } = measurement
    if (!from) {
      measurement.from = { at: now, received }
      return undefined
    }
    if (now - from.at < this.policy.windowMs) return undefined

    const seconds = (now - from.at) / 1000
    const rates: Rates = new Map(
      networks.map((network) => [
        network.id,
        (network.received - (from.received.get(network.id) ?? 0)) / seconds
      ])
    )
    const { last } = measurement
    measurement.from = { at: now, received }
    measurement.last = rates
    measurement.windows++
    // Settled once no network is faster than in the last window by half what a step must gain:
    // any more, and what's still to come of a ramp could pass for a step's gain.
    const settled =
      last !== null &&
      [...rates].every(([id, rate]) => rate <= (last.get(id) ?? 0) * (1 + this.policy.minGain / 2))
    return settled || measurement.windows >= this.policy.maxWindows ? rates : undefined
  }

  /** Adds streams to the next network that can take them, or measures again if none can yet. */
  private grow(snapshot: Snapshot, before: Rates): Action | undefined {
    const { networks, spareWork } = snapshot
    let canGrowLater = false
    for (let i = 0; i < networks.length; i++) {
      const index = (this.next + i) % networks.length
      const network = networks[index]
      if (this.settled.has(network.id) || network.streams >= this.policy.maxPerNetwork) continue
      canGrowLater = true
      const count = Math.min(
        network.streams,
        this.policy.maxPerNetwork - network.streams,
        spareWork
      )
      // A network delivering nothing has no speed to improve on, and one already turning
      // streams away wants no more of them.
      if (count < 1 || network.rejected > 0 || !((before.get(network.id) ?? 0) > 0)) continue

      this.next = (index + 1) % networks.length
      this.phase = {
        kind: 'trial',
        networkId: network.id,
        added: count,
        before,
        rejectedBefore: network.rejected,
        measurement: this.measurement(snapshot)
      }
      return { kind: 'add', networkId: network.id, count }
    }
    this.phase = canGrowLater
      ? { kind: 'measure', measurement: this.measurement(snapshot) }
      : { kind: 'done' }
    return undefined
  }

  private undo(snapshot: Snapshot, phase: Extract<Phase, { kind: 'trial' }>): Action {
    this.settled.add(phase.networkId)
    this.phase = { kind: 'measure', measurement: this.measurement(snapshot) }
    return { kind: 'retire', networkId: phase.networkId, count: phase.added }
  }
}
