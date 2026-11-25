import type { DownloadState } from '@shared/types'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { EMPTY_FLOW, trackFlow, type FlowChange, type FlowSample } from '../utils/combineFlow'
import { groupByNetwork, networkActive, networksInPlay } from '../utils/format'

/** How long "+12 MB/s" stays beside the total speed after a network joins or drops out. */
const CHANGE_SHOWN_MS = 2000

export interface ShownFlowChange extends FlowChange {
  /** New for every change, so the diagram's one-off draw-in and pulse play again for the next. */
  key: number
}

export interface CombineFlow {
  /** The step each network's path is drawn at, by network id (see flowStep). */
  steps: Readonly<Record<string, number>>
  /** The network that just joined or dropped out, for CHANGE_SHOWN_MS. */
  change: ShownFlowChange | null
}

interface FlowState extends CombineFlow {
  downloadId: string
}

const NO_FLOW: CombineFlow = { steps: {}, change: null }

function samplesOf(download: DownloadState): FlowSample[] {
  return networksInPlay(groupByNetwork(download)).map((group) => ({
    id: group.id,
    speedBytesPerSec: group.speedBytesPerSec,
    active: networkActive(group)
  }))
}

function sameSteps(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>
): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/**
 * Follows one download's networks from the store, outside React's render: each update (about
 * five a second) goes through trackFlow, and this re-renders its caller only when a path's step
 * changes or a network joins or drops out — never at the rate updates arrive, let alone the
 * rate frames are drawn. The tracker starts over whenever the download stops running, so a
 * pause and resume is a fresh start rather than every network dropping out and joining again.
 */
export function useCombineFlow(downloadId: string): CombineFlow {
  const [state, setState] = useState<FlowState>({ downloadId, ...NO_FLOW })

  useEffect(() => {
    let tracker = EMPTY_FLOW
    let key = 0
    let hide: ReturnType<typeof setTimeout> | undefined

    const sample = (download: DownloadState): void => {
      if (download.status !== 'downloading') {
        tracker = EMPTY_FLOW
        return
      }
      const result = trackFlow(tracker, samplesOf(download), Date.now())
      tracker = result.tracker
      const steps = Object.fromEntries(
        Object.entries(tracker.networks).map(([id, flow]) => [id, flow.step])
      )
      // A join and a drop in the same sample (one network swapped for another) is rare enough
      // that showing the first is fine; the next change replaces whatever is showing.
      const change = result.changes[0]
      if (change) {
        clearTimeout(hide)
        key += 1
        const shown = { ...change, key }
        hide = setTimeout(
          () =>
            setState((current) =>
              current.downloadId === downloadId && current.change?.key === shown.key
                ? { ...current, change: null }
                : current
            ),
          CHANGE_SHOWN_MS
        )
        setState({ downloadId, steps, change: shown })
        return
      }
      setState((current) =>
        current.downloadId === downloadId && sameSteps(current.steps, steps)
          ? current
          : {
              downloadId,
              steps,
              change: current.downloadId === downloadId ? current.change : null
            }
      )
    }

    const unsubscribe = useAppStore.subscribe((store, previous) => {
      const download = store.downloads[downloadId]
      if (download && download !== previous.downloads[downloadId]) sample(download)
    })
    return () => {
      unsubscribe()
      clearTimeout(hide)
    }
  }, [downloadId])

  // Kept from another download the screen showed before this one (it isn't remounted between
  // them): not this one's.
  return state.downloadId === downloadId ? state : NO_FLOW
}
