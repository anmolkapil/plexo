// What the combine diagram draws for each network, worked out from the speeds a download reports
// (about five times a second): how big a share of the total the network carries, snapped to a
// few steps, and the moments a network starts or stops carrying any of it. Plain functions with
// no React in them, so they can be tested on their own.

/** Steps a flowing network's path can be drawn at, 1 (a trickle) to FLOW_STEPS (nearly all of
 * it). 0 is a network carrying nothing, drawn still. */
export const FLOW_STEPS = 4

// Where each step starts, as a share of the total: step 1 from 0, step 2 from 20%, and so on.
// Two networks splitting the load evenly sit at 50%, in the middle of step 3 rather than on an
// edge, and one network on its own is at the top.
const STEP_FLOORS = [0, 0.2, 0.45, 0.7]

// How far past a step's edge the share must go before the path changes step. Shares wobble by a
// few percent from one sample to the next; without this a network sitting near an edge would
// flip between two steps every update, and each flip changes its animation's speed.
const STEP_HYSTERESIS = 0.05

/** Below this a network counts as carrying nothing: a stream that is connected but stalled, or
 * the last trickle of one that was switched off. */
export const CONTRIBUTING_FLOOR_BYTES_PER_SEC = 32 * 1024

/** How long a network must keep carrying (or not carrying) bytes before it counts as having
 * joined (or dropped out of) the download: long enough that a flapping link, or one stalled
 * stream, doesn't mark a change every few seconds. */
export const SUSTAIN_MS = 2500

// A network's speed is averaged over the last few seconds (SPEED_WINDOW_MS, 3 s, in the main
// process), so one that stops winds down to nothing over about that long. What it carried before
// it began to stop is read from this far back before its speed fell below the floor...
const DROP_LOOKBACK_MS = 2 * SUSTAIN_MS
// ...and so its speeds are kept for this long: that look-back, plus the SUSTAIN_MS it takes to
// confirm the drop, plus a little.
const RECENT_MS = DROP_LOOKBACK_MS + SUSTAIN_MS + 1000

/** The step a network's path is drawn at. A network that isn't `active` (fetching nothing) is
 * still, whatever its last speed. One that is active but has no speed sampled yet flows at the
 * lowest step, so the diagram agrees with the network rows, which go by connection status too.
 * `previous` is the step it was drawn at last time, kept while the share stays near its band. */
export function flowStep(share: number, active: boolean, previous?: number): number {
  if (!active) return 0
  const clamped = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0
  if (previous !== undefined && previous >= 1 && previous <= FLOW_STEPS) {
    const lower = STEP_FLOORS[previous - 1]
    const upper = STEP_FLOORS[previous] ?? Infinity
    if (clamped >= lower - STEP_HYSTERESIS && clamped < upper + STEP_HYSTERESIS) return previous
  }
  let step = 1
  for (let index = 1; index < STEP_FLOORS.length; index++) {
    if (clamped >= STEP_FLOORS[index]) step = index + 1
  }
  return step
}

/** One network as the tracker sees it at one sample. */
export interface FlowSample {
  id: string
  speedBytesPerSec: number
  /** Whether it has a connection fetching right now (see networkActive). */
  active: boolean
}

interface NetworkFlow {
  /** Whether it counts as carrying part of the download, once SUSTAIN_MS has confirmed it. */
  contributing: boolean
  /** When `contributing` last changed (or was first seen). */
  since: number
  /** When its speed first disagreed with `contributing`, while that lasts. */
  pendingSince: number | null
  /** Its speeds over the last RECENT_MS, oldest first. */
  recent: readonly { at: number; speed: number }[]
  /** The step its path is drawn at (see flowStep). */
  step: number
}

export interface FlowTracker {
  networks: Readonly<Record<string, NetworkFlow>>
}

export const EMPTY_FLOW: FlowTracker = { networks: {} }

export interface FlowChange {
  networkId: string
  change: 'joined' | 'dropped'
  /** The speed it brought, or the speed it was carrying before it stopped. */
  bytesPerSec: number
}

/** Takes in one sample of a download's networks and returns the tracker after it, with any
 * network that joined or dropped out. A change counts only once it has held for SUSTAIN_MS.
 *
 * Only a network joining a download others were already carrying is a change worth marking: the
 * download starting (or resuming) brings every network in together, so a join is only reported
 * when another network was already confirmed before this one picked up. Likewise a drop is only
 * reported while another network is still carrying bytes, so the download finishing or every
 * network going quiet together (a server that stopped answering) doesn't read as one leaving. */
export function trackFlow(
  previous: FlowTracker,
  samples: readonly FlowSample[],
  now: number
): { tracker: FlowTracker; changes: FlowChange[] } {
  const total = samples.reduce((sum, sample) => sum + Math.max(0, sample.speedBytesPerSec), 0)
  const changes: FlowChange[] = []
  const networks: Record<string, NetworkFlow> = {}

  for (const sample of samples) {
    const before = previous.networks[sample.id]
    const recent = [
      ...(before?.recent ?? []).filter((entry) => now - entry.at < RECENT_MS),
      { at: now, speed: sample.speedBytesPerSec }
    ]
    const carrying = sample.speedBytesPerSec >= CONTRIBUTING_FLOOR_BYTES_PER_SEC
    const step = flowStep(
      total > 0 ? sample.speedBytesPerSec / total : 0,
      sample.active,
      before?.step
    )

    if (!before) {
      // First seen: nothing has been confirmed about it yet, so it starts as not carrying bytes,
      // and one that already is has to hold that for SUSTAIN_MS like any other.
      networks[sample.id] = {
        contributing: false,
        since: now,
        pendingSince: carrying ? now : null,
        recent,
        step
      }
      continue
    }

    if (carrying === before.contributing) {
      networks[sample.id] = { ...before, pendingSince: null, recent, step }
      continue
    }

    const pendingSince = before.pendingSince ?? now
    if (now - pendingSince < SUSTAIN_MS) {
      networks[sample.id] = { ...before, pendingSince, recent, step }
      continue
    }

    networks[sample.id] = {
      contributing: carrying,
      since: now,
      pendingSince: null,
      recent,
      step
    }
    const others = samples.filter((other) => other.id !== sample.id)
    if (carrying) {
      const alreadyCarried = others.some((other) => {
        const flow = previous.networks[other.id]
        return flow?.contributing === true && flow.since <= pendingSince
      })
      if (alreadyCarried) {
        changes.push({
          networkId: sample.id,
          change: 'joined',
          bytesPerSec: sample.speedBytesPerSec
        })
      }
    } else {
      const stillCarried = others.some(
        (other) =>
          previous.networks[other.id]?.contributing === true &&
          other.speedBytesPerSec >= CONTRIBUTING_FLOOR_BYTES_PER_SEC
      )
      // What it carried before it began to stop: a network switched off winds down over a few
      // seconds, through speeds that are neither what it was doing nor nothing, so its last
      // speed above the floor would undersell it.
      const carried = Math.max(
        0,
        ...before.recent
          .filter((entry) => entry.at >= pendingSince - DROP_LOOKBACK_MS && entry.at < pendingSince)
          .map((entry) => entry.speed)
      )
      if (stillCarried && carried > 0) {
        changes.push({ networkId: sample.id, change: 'dropped', bytesPerSec: carried })
      }
    }
  }

  return { tracker: { networks }, changes }
}
