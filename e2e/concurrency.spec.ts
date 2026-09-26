import { expect, test } from '@playwright/test'
import {
  ConcurrencyController,
  type Action,
  type ConcurrencyPolicy,
  type Snapshot
} from '../src/main/download/concurrency'

// M. How many streams each network runs. The controller is pure, so it's driven here against
// models of what limits a download — the server, the link, an uplink two networks share — with
// the noise and ramp-up of real connections, and judged by where it settles.

const MB = 1e6
const POLICY: ConcurrencyPolicy = {
  maxPerNetwork: 16,
  windowMs: 2000,
  warmupMs: 2000,
  minGain: 0.15,
  maxWindows: 4
}
const TICK_MS = 500
const SEEDS = 200

/** Bytes per second each network settles at, given how many streams each runs. */
type Model = (streams: Map<string, number>) => Map<string, number>

interface Options {
  seconds?: number
  spareWork?: number
  /** Each tick's delivery is off by up to this share, either way. */
  noise?: number
  seed?: number
  /** Seconds a network takes to get most of the way to a new speed (TCP ramping up). */
  ramp?: number
  /** Streams past this many on a network are turned away by the server. */
  accepts?: number
  /** Ticks a retired stream takes to leave. */
  retireTicks?: number
}

interface Run {
  streams: Map<string, number>
  /** Most streams each network had at once. */
  peak: Map<string, number>
  actions: Action[]
  /** What the controller saw whenever it acted. */
  seen: Snapshot[]
}

/** A seeded generator, so a failing case can be run again exactly. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function simulate(model: Model, networks: string[], options: Options = {}): Run {
  const { seconds = 120, spareWork = 1000, noise = 0, seed = 1, ramp = 0 } = options
  const { accepts = Infinity, retireTicks = 1 } = options
  const next = random(seed)
  const controller = new ConcurrencyController(POLICY)
  const streams = new Map(networks.map((id) => [id, 4]))
  const peak = new Map(streams)
  const received = new Map(networks.map((id) => [id, 0]))
  let rates = new Map(networks.map((id) => [id, 0]))
  const leaving: { networkId: string; count: number; at: number }[] = []
  const run: Run = { streams, peak, actions: [], seen: [] }

  for (let now = 0; now <= seconds * 1000; now += TICK_MS) {
    const target = model(streams)
    const lag = ramp ? Math.exp(-TICK_MS / 1000 / ramp) : 0
    rates = new Map(
      networks.map((id) => [id, target.get(id)! + (rates.get(id)! - target.get(id)!) * lag])
    )
    for (const id of networks) {
      const jitter = 1 + noise * (next() * 2 - 1)
      received.set(id, received.get(id)! + (rates.get(id)! * jitter * TICK_MS) / 1000)
    }
    while (leaving.length > 0 && leaving[0].at <= now) {
      const gone = leaving.shift()!
      streams.set(gone.networkId, streams.get(gone.networkId)! - gone.count)
    }
    const snapshot: Snapshot = {
      now,
      networks: networks.map((id) => ({
        id,
        streams:
          streams.get(id)! -
          leaving
            .filter((entry) => entry.networkId === id)
            .reduce((sum, entry) => sum + entry.count, 0),
        received: received.get(id)!,
        rejected: Math.max(0, streams.get(id)! - accepts)
      })),
      spareWork,
      retiring: leaving.reduce((sum, entry) => sum + entry.count, 0)
    }
    const action = controller.tick(snapshot)
    if (!action) continue
    run.actions.push(action)
    run.seen.push(snapshot)
    if (action.kind === 'add') {
      streams.set(action.networkId, streams.get(action.networkId)! + action.count)
      peak.set(
        action.networkId,
        Math.max(peak.get(action.networkId)!, streams.get(action.networkId)!)
      )
    } else {
      leaving.push({ ...action, at: now + retireTicks * TICK_MS })
    }
  }
  return run
}

/** The share of seeds for which `holds` is true. */
function share(holds: (seed: number) => boolean): number {
  let count = 0
  for (let seed = 1; seed <= SEEDS; seed++) if (holds(seed)) count++
  return count / SEEDS
}

/** Each connection gets at most `perStream`, and the link at most `link`. */
const capped =
  (perStream: number, link: number): Model =>
  (streams) =>
    new Map([...streams].map(([id, count]) => [id, Math.min(count * perStream, link)]))

/** Networks behind one uplink of `link`, each connection good for `perStream`. */
const sharedUplink =
  (perStream: number, link: number): Model =>
  (streams) => {
    const total = [...streams.values()].reduce((sum, count) => sum + count, 0)
    const delivered = Math.min(total * perStream, link)
    return new Map([...streams].map(([id, count]) => [id, (delivered * count) / total]))
  }

/** Ethernet full at 100 MB/s beside a cellular link, which more streams speed up or don't. */
const besideEthernet =
  (cellularGains: boolean): Model =>
  (streams) =>
    new Map([
      ['ethernet', Math.min(streams.get('ethernet')! * 50 * MB, 100 * MB)],
      ['cellular', cellularGains ? streams.get('cellular')! * 0.25 * MB : 1 * MB]
    ])

test.describe('stream count', () => {
  test('a server that caps each connection gets more of them, up to the limit', () => {
    const { streams, actions } = simulate(capped(1 * MB, 1000 * MB), ['a'])
    expect(streams.get('a')).toBe(16)
    // Doubling: two steps, not twelve.
    expect(actions).toEqual([
      { kind: 'add', networkId: 'a', count: 4 },
      { kind: 'add', networkId: 'a', count: 8 }
    ])
    expect(
      share(
        (seed) =>
          simulate(capped(1 * MB, 1000 * MB), ['a'], { noise: 0.1, seed }).streams.get('a') === 16
      )
    ).toBe(1)
  })

  test('a full link keeps what it started with: the extra streams are tried, then retired', () => {
    const { streams, peak } = simulate(capped(10 * MB, 20 * MB), ['a'])
    expect(peak.get('a')).toBe(8)
    expect(streams.get('a')).toBe(4)
    expect(
      share(
        (seed) =>
          simulate(capped(10 * MB, 20 * MB), ['a'], { noise: 0.1, seed }).streams.get('a') === 4
      )
    ).toBe(1)
  })

  test('grows while it pays and stops where it stops paying', () => {
    // 4 streams: 4 MB/s. 8: 8 MB/s. 16 would be the 10 MB/s link: +25%, which still pays.
    expect(simulate(capped(1 * MB, 10 * MB), ['a']).streams.get('a')).toBe(16)
    // A 9 MB/s link: 16 streams would add 1 MB/s to 8, under the 15% a step has to earn.
    expect(simulate(capped(1 * MB, 9 * MB), ['a']).streams.get('a')).toBe(8)
  })

  test('a slow network is judged by its own gain, not lost in a fast one’s noise', () => {
    // Cellular's doubling is worth 1 MB/s; Ethernet's everyday ±10% is worth ±10 MB/s.
    const grows = share(
      (seed) =>
        simulate(besideEthernet(true), ['ethernet', 'cellular'], { noise: 0.1, seed }).streams.get(
          'cellular'
        ) === 16
    )
    const staysPut = share(
      (seed) =>
        simulate(besideEthernet(false), ['ethernet', 'cellular'], { noise: 0.1, seed }).streams.get(
          'cellular'
        ) === 4
    )
    expect(grows).toBeGreaterThanOrEqual(0.95)
    expect(staysPut).toBeGreaterThanOrEqual(0.95)
  })

  test('streams that only take speed from a network behind the same uplink are retired', () => {
    const { streams, peak } = simulate(sharedUplink(1 * MB, 8 * MB), ['wifi', 'ethernet'])
    expect(peak.get('wifi')).toBe(8)
    expect(peak.get('ethernet')).toBe(8)
    expect(streams).toEqual(
      new Map([
        ['wifi', 4],
        ['ethernet', 4]
      ])
    )
    const bothStay = share((seed) => {
      const run = simulate(sharedUplink(1 * MB, 8 * MB), ['wifi', 'ethernet'], { noise: 0.1, seed })
      return run.streams.get('wifi') === 4 && run.streams.get('ethernet') === 4
    })
    expect(bothStay).toBeGreaterThanOrEqual(0.95)
  })

  test('speeds still ramping up are waited out, not mistaken for a step’s gain', () => {
    // A full link whose connections take seconds to reach speed: measuring them halfway up would
    // make the first doubling look like it paid.
    for (const ramp of [1, 2, 4]) {
      const staysPut = share(
        (seed) =>
          simulate(capped(10 * MB, 20 * MB), ['a'], { ramp, noise: 0.05, seed }).streams.get(
            'a'
          ) === 4
      )
      expect(staysPut, `ramping over ${ramp} s`).toBeGreaterThanOrEqual(0.95)
    }
  })

  test('new streams the server turns away are retired, and the network grows no further', () => {
    const { streams, actions } = simulate(capped(1 * MB, 1000 * MB), ['a'], { accepts: 4 })
    expect(streams.get('a')).toBe(4)
    expect(actions).toEqual([
      { kind: 'add', networkId: 'a', count: 4 },
      { kind: 'retire', networkId: 'a', count: 4 }
    ])
  })

  test('nothing is measured while retired streams are still leaving', () => {
    // Two networks behind one uplink: each step is undone, and the next network's is only taken
    // once the last one's streams have gone.
    const run = simulate(sharedUplink(1 * MB, 8 * MB), ['wifi', 'ethernet'], { retireTicks: 6 })
    expect(run.actions.map((action) => action.kind)).toEqual(['add', 'retire', 'add', 'retire'])
    for (const [index, action] of run.actions.entries()) {
      if (action.kind === 'add') expect(run.seen[index].retiring).toBe(0)
    }
  })

  test('no growth without waiting blocks for the new streams to take', () => {
    expect(simulate(capped(1 * MB, 1000 * MB), ['a'], { spareWork: 0 }).actions).toEqual([])
    // Room for two more: the step is cut to fit.
    expect(simulate(capped(1 * MB, 1000 * MB), ['a'], { spareWork: 2 }).actions[0]).toEqual({
      kind: 'add',
      networkId: 'a',
      count: 2
    })
  })

  test('a network joining or leaving mid-step undoes the step, and a network that rejoins can grow again', () => {
    const controller = new ConcurrencyController(POLICY)
    const received = new Map([
      ['a', 0],
      ['b', 0]
    ])
    const streams = new Map([
      ['a', 4],
      ['b', 4]
    ])
    let now = 0
    const tick = (ids: string[]): Action | undefined => {
      // A server that caps each connection at 0.5 MB/s: another stream always pays.
      for (const id of ids) received.set(id, received.get(id)! + streams.get(id)! * 0.25 * MB)
      now += TICK_MS
      return controller.tick({
        now,
        networks: ids.map((id) => ({
          id,
          streams: streams.get(id)!,
          received: received.get(id)!,
          rejected: 0
        })),
        spareWork: 1000,
        retiring: 0
      })
    }
    let action: Action | undefined
    while (!(action = tick(['a', 'b']))) expect(now).toBeLessThan(60_000)
    expect(action.kind).toBe('add')
    const grown = action.networkId
    const other = grown === 'a' ? 'b' : 'a'
    streams.set(grown, streams.get(grown)! + action.count)

    // The other network drops out before the step is judged: its speed going says nothing about
    // the step, so the step is undone rather than judged against it.
    expect(tick([grown])).toEqual({ kind: 'retire', networkId: grown, count: action.count })
    streams.set(grown, 4)

    // Back again, it is grown like any network that has just joined.
    for (let added = false; !added;) {
      const next = tick(['a', 'b'])
      if (next?.kind === 'add' && next.networkId === other) added = true
      else if (next?.kind === 'add')
        streams.set(next.networkId, streams.get(next.networkId)! + next.count)
      expect(now).toBeLessThan(120_000)
    }
  })

  test('a pause mid-step gives back the untried streams; what was settled stays settled', () => {
    const controller = new ConcurrencyController(POLICY)
    const tick = (now: number, streams: number, received: number): Action | undefined =>
      controller.tick({
        now,
        networks: [{ id: 'a', streams, received, rejected: 0 }],
        spareWork: 1000,
        retiring: 0
      })
    // 1 MB/s whatever the stream count: a full link.
    let received = 0
    let now = 0
    let streams = 4
    const until = (done: (action: Action) => boolean): Action => {
      for (; now < 60_000; now += TICK_MS) {
        received += 0.5 * MB
        const action = tick(now, streams, received)
        if (action && done(action)) return action
      }
      throw new Error('never happened')
    }
    until((action) => action.kind === 'add')
    streams = 8
    now += TICK_MS
    // Paused partway through judging the step.
    expect(controller.interrupt()).toEqual({ kind: 'retire', networkId: 'a', count: 4 })
    streams = 4
    // Resumed: the step is tried again from scratch, found not to pay, and not tried a third time.
    expect(until((action) => action.kind === 'retire')).toEqual({
      kind: 'retire',
      networkId: 'a',
      count: 4
    })
    streams = 4
    expect(controller.interrupt()).toBeUndefined()
    for (let end = now + 30_000; now < end; now += TICK_MS) {
      received += 0.5 * MB
      expect(tick(now, streams, received)).toBeUndefined()
    }
  })
})
