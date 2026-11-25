import { expect, test } from '@playwright/test'
import {
  CONTRIBUTING_FLOOR_BYTES_PER_SEC,
  EMPTY_FLOW,
  flowStep,
  SUSTAIN_MS,
  trackFlow,
  type FlowChange,
  type FlowSample
} from '../src/renderer/src/utils/combineFlow'

// The combine diagram's arithmetic on its own: which step a network's path is drawn at, and when
// a network counts as having joined or dropped out of the download. The screen itself is in
// combineDiagram.spec.ts.

const MiB = 1024 ** 2
/** How often these runs feed the tracker: faster than the window hears about a download (every
 * 200 ms, UI_UPDATE_MS in the main process), so each change lands on the exact time it's due. */
const UPDATE_MS = 100

/** Speeds by network id at one moment; a network left out isn't in play. */
type Speeds = Record<string, number>

/** Feeds `timeline` to the tracker one update at a time, as the screen would, and returns every
 * change it marked with when. Each entry holds from its time until the next entry's. */
function run(
  timeline: [atMs: number, speeds: Speeds][],
  untilMs: number
): (FlowChange & { at: number })[] {
  let tracker = EMPTY_FLOW
  const changes: (FlowChange & { at: number })[] = []
  for (let now = 0; now <= untilMs; now += UPDATE_MS) {
    const speeds = timeline.findLast(([at]) => at <= now)?.[1] ?? {}
    const samples: FlowSample[] = Object.entries(speeds).map(([id, speedBytesPerSec]) => ({
      id,
      speedBytesPerSec,
      active: speedBytesPerSec > 0
    }))
    const result = trackFlow(tracker, samples, now)
    tracker = result.tracker
    changes.push(...result.changes.map((change) => ({ ...change, at: now })))
  }
  return changes
}

test.describe('combine diagram flow @smoke', () => {
  test('a path’s step follows its share of the total, in a few steps', () => {
    expect(flowStep(0.6, false), 'fetching nothing: still, whatever its share').toBe(0)
    expect(flowStep(0, true), 'fetching with no speed yet: the slowest flow').toBe(1)
    expect(flowStep(0.1, true)).toBe(1)
    expect(flowStep(0.3, true)).toBe(2)
    expect(flowStep(0.5, true), 'an even split between two').toBe(3)
    expect(flowStep(0.33, true), 'an even split between three').toBe(2)
    expect(flowStep(1, true), 'carrying it alone').toBe(4)
    expect(flowStep(Number.NaN, true)).toBe(1)
    expect(flowStep(1.5, true)).toBe(4)
  })

  test('a share wobbling around a step’s edge keeps its step', () => {
    // Step 3 runs from 45% to 70%: just under its floor, a network already there stays.
    expect(flowStep(0.42, true, 3)).toBe(3)
    expect(flowStep(0.42, true, 2)).toBe(2)
    expect(flowStep(0.47, true, 2), 'just over, from below').toBe(2)
    // Well past the edge, it moves.
    expect(flowStep(0.38, true, 3)).toBe(2)
    expect(flowStep(0.52, true, 2)).toBe(3)
    expect(flowStep(0.95, true, 2), 'more than one step at once').toBe(4)
    // From still, or a step that doesn't exist, it goes by the share alone.
    expect(flowStep(0.42, true, 0)).toBe(2)
    expect(flowStep(0.42, true, 9)).toBe(2)
  })

  test('networks starting together are no change; one switched on later joins once', () => {
    const together = run(
      [
        [0, { a: 0, b: 0 }],
        [400, { a: 2 * MiB, b: 0 }],
        [600, { a: 2 * MiB, b: 1 * MiB }]
      ],
      10_000
    )
    expect(together, 'the download starting brings both in').toEqual([])

    const later = run(
      [
        [0, { a: 2 * MiB }],
        [6000, { a: 2 * MiB, b: 0 }],
        [6400, { a: 2 * MiB, b: 1.5 * MiB }]
      ],
      15_000
    )
    expect(later).toEqual([
      { networkId: 'b', change: 'joined', bytesPerSec: 1.5 * MiB, at: 6400 + SUSTAIN_MS }
    ])
  })

  test('a link that keeps flapping is never marked', () => {
    const timeline: [number, Speeds][] = [[0, { a: 2 * MiB, b: 0 }]]
    // b on for a second, off for a second, from 5 s on: never long enough either way.
    for (let at = 5000; at < 20_000; at += 1000) {
      timeline.push([at, { a: 2 * MiB, b: (at / 1000) % 2 === 1 ? MiB : 0 }])
    }
    expect(run(timeline, 20_000)).toEqual([])
  })

  test('a network that stops while another carries on drops out once, with what it carried', () => {
    const changes = run(
      [
        [0, { a: 2 * MiB, b: 1 * MiB }],
        [3000, { a: 2 * MiB, b: 1.2 * MiB }],
        // Switched off, it winds down over a few seconds: what it took away is what it carried
        // before that, not the last speed it had on the way down.
        [8000, { a: 2.5 * MiB, b: 0.8 * MiB }],
        [9000, { a: 2.5 * MiB, b: 0.4 * MiB }],
        [10_000, { a: 2.5 * MiB, b: 0.1 * MiB }],
        [10_800, { a: 2.5 * MiB, b: CONTRIBUTING_FLOOR_BYTES_PER_SEC / 2 }],
        [11_000, { a: 2.5 * MiB, b: 0 }]
      ],
      15_000
    )
    expect(changes).toEqual([
      { networkId: 'b', change: 'dropped', bytesPerSec: 1.2 * MiB, at: 10_800 + SUSTAIN_MS }
    ])
  })

  test('every network going quiet together is no drop', () => {
    const changes = run(
      [
        [0, { a: 2 * MiB, b: 1 * MiB }],
        [8000, { a: 0, b: 0 }]
      ],
      15_000
    )
    expect(changes).toEqual([])
  })

  test('a network back after dropping out joins again', () => {
    const changes = run(
      [
        [0, { a: 2 * MiB, b: 1 * MiB }],
        [5000, { a: 2 * MiB, b: 0 }],
        [10_000, { a: 2 * MiB, b: 1 * MiB }]
      ],
      15_000
    )
    expect(changes.map(({ change, at }) => [change, at])).toEqual([
      ['dropped', 5000 + SUSTAIN_MS],
      ['joined', 10_000 + SUSTAIN_MS]
    ])
  })

  test('the tracker keeps a path’s step between samples', () => {
    // Two networks near an even split: b's share wobbles 42–48% around step 3's floor.
    let tracker = EMPTY_FLOW
    const steps: number[] = []
    for (const [index, b] of [0.48, 0.42, 0.47, 0.43, 0.46, 0.42].entries()) {
      const result = trackFlow(
        tracker,
        [
          { id: 'a', speedBytesPerSec: (1 - b) * MiB, active: true },
          { id: 'b', speedBytesPerSec: b * MiB, active: true }
        ],
        index * UPDATE_MS
      )
      tracker = result.tracker
      steps.push(tracker.networks['b'].step)
    }
    expect(steps).toEqual([3, 3, 3, 3, 3, 3])
  })
})
