import { expect, test } from '@playwright/test'
import {
  ConcurrencyController,
  DISK_PATIENCE_MS,
  DISK_RECOVER_MS,
  DISK_STALLED_MS,
  DiskWatch,
  RECOVER_MS,
  type Action,
  type NetworkSnapshot
} from '../src/main/download/concurrency'

// M. How many streams each network runs. The controller is pure, so each rule is checked against
// the exact situation it is for.

const MAX = 32

const network = (
  id: string,
  streams: number,
  over: Partial<NetworkSnapshot> = {}
): NetworkSnapshot => ({
  id,
  streams,
  answered: streams,
  refused: 0,
  served: streams,
  ...over
})

test.describe('stream count', () => {
  test('doubles once every stream is receiving, up to the limit', () => {
    const controller = new ConcurrencyController(MAX)
    const counts: number[] = []
    for (let streams = 8; streams < MAX;) {
      const actions = controller.tick({
        now: 0,
        networks: [network('a', streams)],
        spareWork: 1000
      })
      expect(actions).toHaveLength(1)
      streams += actions[0].count
      counts.push(streams)
    }
    expect(counts).toEqual([16, 32])
    expect(controller.tick({ now: 0, networks: [network('a', MAX)], spareWork: 1000 })).toEqual([])
  })

  test('waits while any stream has yet to receive anything', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({ now: 0, networks: [network('a', 8, { answered: 7 })], spareWork: 1000 })
    ).toEqual([])
  })

  test('adds no more streams than the waiting blocks can keep busy', () => {
    const controller = new ConcurrencyController(MAX)
    expect(controller.tick({ now: 0, networks: [network('a', 8)], spareWork: 3 })).toEqual([
      { kind: 'add', networkId: 'a', count: 3 }
    ])
    expect(controller.tick({ now: 0, networks: [network('a', 8)], spareWork: 0 })).toEqual([])
    // The waiting blocks are shared: the first network takes what it can use.
    expect(
      controller.tick({ now: 0, networks: [network('a', 8), network('b', 8)], spareWork: 10 })
    ).toEqual([
      { kind: 'add', networkId: 'a', count: 8 },
      { kind: 'add', networkId: 'b', count: 2 }
    ])
  })

  test('streams the server refuses close, and it never grows past the ones left again', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 16, { served: 10, refused: 6 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 6 }])
    // All well again, but not yet for a minute: still no growth past 10.
    expect(controller.tick({ now: 0, networks: [network('a', 10)], spareWork: 1000 })).toEqual([])
    // A stream lost some other way is made up for, back to the limit and no further.
    expect(controller.tick({ now: 0, networks: [network('a', 7)], spareWork: 1000 })).toEqual([
      { kind: 'add', networkId: 'a', count: 3 }
    ])
  })

  test('streams that have yet to receive anything are not taken for refused ones', () => {
    // One stream refused just after starting, while the other seven were still connecting: the
    // limit is the seven, not the none that had answered yet.
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 8, { answered: 0, served: 0, refused: 1 })],
        spareWork: 1000
      })
    ).toEqual([])
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 8, { served: 7, refused: 1 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 1 }])
    expect(controller.tick({ now: 0, networks: [network('a', 7)], spareWork: 1000 })).toEqual([])
  })

  test('a server refusing while it sends nothing is not limiting connections: the count stays', () => {
    // Busy, or the link expired: waited out or reported elsewhere, not a reason to close streams.
    // Refusals spread over a few looks don't add up to a limit either.
    const controller = new ConcurrencyController(MAX)
    for (const refused of [16, 5, 11]) {
      expect(
        controller.tick({
          now: 0,
          networks: [network('a', 16, { served: 0, refused })],
          spareWork: 1000
        })
      ).toEqual([])
    }
    // Once it serves again, the network grows as before.
    expect(controller.tick({ now: 0, networks: [network('a', 16)], spareWork: 1000 })).toEqual([
      { kind: 'add', networkId: 'a', count: 16 }
    ])
  })

  test('a later refusal lowers the limit further', () => {
    const controller = new ConcurrencyController(MAX)
    controller.tick({
      now: 0,
      networks: [network('a', 16, { served: 10, refused: 6 })],
      spareWork: 1000
    })
    // A later partial refusal on fewer streams lowers it again.
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 10, { served: 8, refused: 2 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 2 }])
    expect(controller.tick({ now: 0, networks: [network('a', 6)], spareWork: 1000 })).toEqual([
      { kind: 'add', networkId: 'a', count: 2 }
    ])
  })

  test('each network is decided on its own', () => {
    const controller = new ConcurrencyController(MAX)
    // b is refused and one of a's streams hasn't answered: only b changes, and a is untouched.
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 8, { answered: 7 }), network('b', 16, { served: 8, refused: 8 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'b', count: 8 }])
    // A network that left and came back keeps its limit, and one that never refused grows.
    expect(
      controller.tick({ now: 0, networks: [network('a', 8), network('b', 8)], spareWork: 1000 })
    ).toEqual([{ kind: 'add', networkId: 'a', count: 8 }])
  })

  test('a lowered limit climbs back by one a minute without refusals, up to the maximum', () => {
    const controller = new ConcurrencyController(MAX)
    const tick = (now: number, streams: number, over: Partial<NetworkSnapshot> = {}): Action[] =>
      controller.tick({ now, networks: [network('a', streams, over)], spareWork: 1000 })
    expect(tick(0, 16, { served: 10, refused: 6 })).toEqual([
      { kind: 'retire', networkId: 'a', count: 6 }
    ])
    expect(tick(RECOVER_MS - 1, 10)).toEqual([])
    expect(tick(RECOVER_MS, 10)).toEqual([{ kind: 'add', networkId: 'a', count: 1 }])
    expect(tick(RECOVER_MS + 1, 11)).toEqual([])
    expect(tick(2 * RECOVER_MS, 11)).toEqual([{ kind: 'add', networkId: 'a', count: 1 }])
    // Refused again at 12: back to 11, and the minute starts over.
    expect(tick(2 * RECOVER_MS + 1, 12, { served: 11, refused: 1 })).toEqual([
      { kind: 'retire', networkId: 'a', count: 1 }
    ])
    expect(tick(3 * RECOVER_MS, 11)).toEqual([])
    expect(tick(3 * RECOVER_MS + 1, 11)).toEqual([{ kind: 'add', networkId: 'a', count: 1 }])
  })

  test('a limit recovered all the way lets the network double again', () => {
    const controller = new ConcurrencyController(8)
    controller.tick({
      now: 0,
      networks: [network('a', 8, { served: 7, refused: 1 })],
      spareWork: 1000
    })
    expect(
      controller.tick({ now: RECOVER_MS, networks: [network('a', 7)], spareWork: 1000 })
    ).toEqual([{ kind: 'add', networkId: 'a', count: 1 }])
    // Back at the maximum: nothing left to remember.
    expect(
      controller.tick({ now: RECOVER_MS + 1, networks: [network('a', 8)], spareWork: 1000 })
    ).toEqual([])
  })

  test('downloads running at once share a network: one starting retires the extra streams', () => {
    let downloads = 1
    const controller = new ConcurrencyController(MAX, true, () => Math.floor(MAX / downloads))
    expect(controller.limit('a')).toBe(32)
    downloads = 4
    expect(controller.tick({ now: 0, networks: [network('a', 32)], spareWork: 1000 })).toEqual([
      { kind: 'retire', networkId: 'a', count: 24 }
    ])
    downloads = 2
    expect(controller.tick({ now: 0, networks: [network('a', 8)], spareWork: 1000 })).toEqual([
      { kind: 'add', networkId: 'a', count: 8 }
    ])
  })

  test('a count the user picked is kept, not grown, and still backs off when refused', () => {
    const controller = new ConcurrencyController(4, false)
    expect(controller.tick({ now: 0, networks: [network('a', 4)], spareWork: 1000 })).toEqual([])
    // A stream lost some other way is made up for.
    expect(controller.tick({ now: 0, networks: [network('a', 3)], spareWork: 1000 })).toEqual([
      { kind: 'add', networkId: 'a', count: 1 }
    ])
    expect(
      controller.tick({
        now: 0,
        networks: [network('a', 4, { served: 3, refused: 1 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 1 }])
    // And recovers to the pick, never past it.
    expect(
      controller.tick({ now: RECOVER_MS, networks: [network('a', 3)], spareWork: 1000 })
    ).toEqual([{ kind: 'add', networkId: 'a', count: 1 }])
    expect(
      controller.tick({ now: 2 * RECOVER_MS, networks: [network('a', 4)], spareWork: 1000 })
    ).toEqual([])
  })

  test('the disk is judged by the clock: looks close together are not patience', () => {
    const controller = new ConcurrencyController(MAX)
    const tick = (now: number, streams: number): Action[] =>
      controller.tick({
        now,
        networks: [network('a', streams)],
        spareWork: 1000,
        disk: { reading: 'behind', since: 0 }
      })
    // Not before it has lasted, and no growth meanwhile.
    expect(tick(0, 16)).toEqual([])
    expect(tick(1, 16)).toEqual([])
    expect(tick(DISK_PATIENCE_MS - 1, 16)).toEqual([])
    expect(tick(DISK_PATIENCE_MS, 16)).toEqual([{ kind: 'retire', networkId: 'a', count: 8 }])
    // The next cut needs as long again at the new count.
    expect(tick(DISK_PATIENCE_MS + 1, 8)).toEqual([])
    expect(tick(2 * DISK_PATIENCE_MS, 8)).toEqual([{ kind: 'retire', networkId: 'a', count: 4 }])
  })

  test('a disk behind at every count is left with one stream, and keeps it', () => {
    const counts = run(new ConcurrencyController(MAX), 32, 30_000, () => true)
    expect(counts.indexOf(1) * LOOK_MS).toBeLessThanOrEqual(6 * DISK_PATIENCE_MS)
    expect(counts.slice(counts.indexOf(1))).toEqual(counts.slice(counts.indexOf(1)).map(() => 1))
  })

  test('a disk that was only busy for a moment soon gives the streams back', () => {
    const counts = run(new ConcurrencyController(MAX), 32, 30_000, (_, now) => now < 1_000)
    expect(Math.min(...counts)).toBe(16)
    expect(counts.indexOf(32, 1) * LOOK_MS).toBeLessThanOrEqual(
      2 * DISK_PATIENCE_MS + DISK_RECOVER_MS
    )
    expect(counts.at(-1)).toBe(32)
  })

  test('keeping up below the cap says nothing about it, so the cap stays', () => {
    const controller = new ConcurrencyController(MAX)
    const tick = (now: number, streams: number, spareWork: number): Action[] =>
      controller.tick({
        now,
        networks: [network('a', streams)],
        spareWork,
        disk:
          now <= DISK_PATIENCE_MS
            ? { reading: 'behind', since: 0 }
            : { reading: 'keeping-up', since: DISK_PATIENCE_MS }
      })
    expect(tick(DISK_PATIENCE_MS, 32, 1000)).toEqual([
      { kind: 'retire', networkId: 'a', count: 16 }
    ])
    // Few blocks left to fetch keep it at 3 while the disk keeps up; then more are waiting.
    expect(tick(DISK_PATIENCE_MS + DISK_RECOVER_MS, 3, 0)).toEqual([])
    expect(tick(DISK_PATIENCE_MS + DISK_RECOVER_MS + 1, 6, 1000)).toEqual([
      { kind: 'add', networkId: 'a', count: 6 }
    ])
    // Back at the cap, it has to keep up there before the cap rises.
    const back = DISK_PATIENCE_MS + DISK_RECOVER_MS + 2
    expect(tick(back, 16, 1000)).toEqual([])
    expect(tick(back + DISK_RECOVER_MS, 16, 1000)).toEqual([
      { kind: 'add', networkId: 'a', count: 16 }
    ])
  })

  test('a disk cut leaves a server ceiling, and its pace, alone', () => {
    const counts = run(
      new ConcurrencyController(MAX),
      32,
      RECOVER_MS - LOOK_MS,
      (_, now) => now >= 500 && now < 2_000,
      (now) => (now === 0 ? 2 : 0)
    )
    // Back at the 30 the server allowed at the disk's pace, not a stream a minute; never past it.
    expect(Math.min(...counts)).toBe(8)
    expect(counts.at(-1)).toBe(30)
    expect(Math.max(...counts.slice(1))).toBe(30)
  })

  test('a refusal at the moment the disk cuts still counts', () => {
    const counts = run(
      new ConcurrencyController(MAX),
      32,
      RECOVER_MS,
      (_, now) => now < 2_000,
      (now) => (now === DISK_PATIENCE_MS ? 5 : 0)
    )
    expect(Math.min(...counts)).toBe(4)
    expect(Math.max(...counts.slice(1))).toBe(27)
  })

  test('a disk behind only now and then neither cuts nor raises', () => {
    // Behind long enough for one cut, then every other look.
    const counts = run(new ConcurrencyController(MAX), 32, 60_000, (_, now) =>
      now <= DISK_PATIENCE_MS ? true : (now / LOOK_MS) % 2 === 1
    )
    expect(counts.slice(DISK_PATIENCE_MS / LOOK_MS)).toEqual(
      counts.slice(DISK_PATIENCE_MS / LOOK_MS).map(() => 16)
    )
  })

  test('the disk cuts every network together', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({
        now: DISK_PATIENCE_MS,
        networks: [network('a', 8), network('b', 8)],
        spareWork: 0,
        disk: { reading: 'behind', since: 0 }
      })
    ).toEqual([
      { kind: 'retire', networkId: 'a', count: 4 },
      { kind: 'retire', networkId: 'b', count: 4 }
    ])
  })

  test('the disk leaves a count the user picked alone', () => {
    const counts = run(new ConcurrencyController(4, false), 4, 30_000, () => true)
    expect(counts).toEqual(counts.map(() => 4))
  })
})

test.describe('disk watch', () => {
  test('reads the download as a whole, by the clock', () => {
    const watch = new DiskWatch()
    watch.landed(0)
    watch.sample(0, 8, 5)
    expect(watch.reading).toBe('behind')
    watch.sample(400, 8, 6)
    expect(watch.lasted('behind', 400)).toBe(400)
    // Held, but nothing has landed for a while: a stalled disk isn't judged.
    watch.sample(DISK_STALLED_MS, 8, 8)
    expect(watch.reading).toBe('unknown')
    // Half held is not most.
    watch.landed(2_000)
    watch.sample(2_000, 8, 4)
    expect(watch.reading).toBe('keeping-up')
    expect(watch.lasted('behind', 2_000)).toBe(0)
  })
})

const LOOK_MS = 500

/** One network, looked at every LOOK_MS from 0 to `ms` as HttpTransfer does: all its streams are
 * held while `behind`, and the server refuses `refused` of them. The streams it ran after each
 * look. */
function run(
  controller: ConcurrencyController,
  streams: number,
  ms: number,
  behind: (streams: number, now: number) => boolean,
  refused: (now: number) => number = () => 0
): number[] {
  const watch = new DiskWatch()
  const counts: number[] = []
  for (let now = 0; now <= ms; now += LOOK_MS) {
    watch.landed(now)
    watch.sample(now, streams, behind(streams, now) ? streams : 0)
    const refusedNow = refused(now)
    const actions = controller.tick({
      now,
      networks: [network('a', streams, { refused: refusedNow, served: streams - refusedNow })],
      spareWork: 1000,
      disk: { reading: watch.reading, since: watch.since }
    })
    for (const action of actions) streams += action.kind === 'add' ? action.count : -action.count
    counts.push(streams)
  }
  return counts
}
