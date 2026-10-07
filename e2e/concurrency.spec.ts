import { expect, test } from '@playwright/test'
import {
  ConcurrencyController,
  DISK_PATIENCE_TICKS,
  DISK_RECOVER_MS,
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

  test('a disk that holds most streams up halves them, and they double back once it keeps up', () => {
    const controller = new ConcurrencyController(MAX)
    const tick = (now: number, streams: number, held: number): Action[] =>
      controller.tick({ now, networks: [network('a', streams, { held })], spareWork: 1000 })
    // Not before it has lasted, and no growth meanwhile.
    for (let i = 1; i < DISK_PATIENCE_TICKS; i++) expect(tick(0, 32, 20)).toEqual([])
    expect(tick(0, 32, 20)).toEqual([{ kind: 'retire', networkId: 'a', count: 16 }])
    // Half held is not most.
    for (let i = 0; i < 2 * DISK_PATIENCE_TICKS; i++) expect(tick(1, 16, 8)).toEqual([])
    expect(tick(DISK_RECOVER_MS, 16, 0)).toEqual([{ kind: 'add', networkId: 'a', count: 16 }])
  })

  test('the disk leaves a count the user picked alone', () => {
    const controller = new ConcurrencyController(4, false)
    for (let i = 0; i < 2 * DISK_PATIENCE_TICKS; i++)
      expect(
        controller.tick({ now: 0, networks: [network('a', 4, { held: 4 })], spareWork: 1000 })
      ).toEqual([])
  })
})
