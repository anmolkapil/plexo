import { expect, test } from '@playwright/test'
import { ConcurrencyController, type NetworkSnapshot } from '../src/main/download/concurrency'

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
  accepted: streams,
  refused: 0,
  ...over
})

test.describe('stream count', () => {
  test('doubles once every stream is receiving, up to the limit', () => {
    const controller = new ConcurrencyController(MAX)
    const counts: number[] = []
    for (let streams = 8; streams < MAX;) {
      const actions = controller.tick({ networks: [network('a', streams)], spareWork: 1000 })
      expect(actions).toHaveLength(1)
      streams += actions[0].count
      counts.push(streams)
    }
    expect(counts).toEqual([16, 32])
    expect(controller.tick({ networks: [network('a', MAX)], spareWork: 1000 })).toEqual([])
  })

  test('waits while any stream has yet to receive anything', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({ networks: [network('a', 8, { answered: 7 })], spareWork: 1000 })
    ).toEqual([])
  })

  test('adds no more streams than the waiting blocks can keep busy', () => {
    const controller = new ConcurrencyController(MAX)
    expect(controller.tick({ networks: [network('a', 8)], spareWork: 3 })).toEqual([
      { kind: 'add', networkId: 'a', count: 3 }
    ])
    expect(controller.tick({ networks: [network('a', 8)], spareWork: 0 })).toEqual([])
    // The waiting blocks are shared: the first network takes what it can use.
    expect(
      controller.tick({ networks: [network('a', 8), network('b', 8)], spareWork: 10 })
    ).toEqual([
      { kind: 'add', networkId: 'a', count: 8 },
      { kind: 'add', networkId: 'b', count: 2 }
    ])
  })

  test('a refusal keeps the streams the server accepted, and it never grows past them again', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({
        networks: [network('a', 16, { answered: 10, accepted: 10, refused: 6 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 6 }])
    // Later, all well again: still no growth past 10.
    expect(controller.tick({ networks: [network('a', 10)], spareWork: 1000 })).toEqual([])
  })

  test('a refusal before anything was accepted still leaves a stream', () => {
    const controller = new ConcurrencyController(MAX)
    expect(
      controller.tick({
        networks: [network('a', 8, { answered: 0, accepted: 0, refused: 8 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'a', count: 7 }])
  })

  test('each network is decided on its own', () => {
    const controller = new ConcurrencyController(MAX)
    // b is refused and one of a's streams hasn't answered: only b changes, and a is untouched.
    expect(
      controller.tick({
        networks: [network('a', 8, { answered: 7 }), network('b', 16, { accepted: 8, refused: 3 })],
        spareWork: 1000
      })
    ).toEqual([{ kind: 'retire', networkId: 'b', count: 8 }])
    // A network that left and came back keeps its limit, and one that never refused grows.
    expect(
      controller.tick({ networks: [network('a', 8), network('b', 8)], spareWork: 1000 })
    ).toEqual([{ kind: 'add', networkId: 'a', count: 8 }])
  })
})
