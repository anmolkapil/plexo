import { applyDownloadUpdate } from '@shared/downloadUpdate'
import type {
  AppSettings,
  DownloadState,
  DownloadUpdate,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  QueueItem,
  QueueState,
  ThemeSource,
  UpdateInfo
} from '@shared/types'
import { create } from 'zustand'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

const SPEED_HISTORY_LENGTH = 60
const SPEED_SAMPLE_INTERVAL_MS = 1000

// Throttling cadence lives outside the store's own state — it's bookkeeping for how often to
// sample, not something a component should ever read or re-render on.
let lastSpeedSampleAt = 0

interface AppStore {
  interfaces: NetworkInterfaceInfo[]
  interfacesStatus: LoadStatus
  interfacesError: string | null
  latencies: Record<string, number | null>
  /** User customizations (name/color) per network interface id — persisted in the main process. */
  networkPreferences: NetworkPreferences

  /** Persisted in the main process alongside nativeTheme.themeSource. */
  themeSource: ThemeSource

  /** Null until the one-time startup check resolves, or if it found nothing worth showing
   * (already up to date, already dismissed, or the check failed). */
  availableUpdate: UpdateInfo | null

  homeDir: string
  downloadsDir: string

  /** Plexo focuses on one download at a time — this is it. */
  currentDownload: DownloadState | null
  speedHistory: number[]
  /** Same rolling window as speedHistory, split by physical network — for the stacked
   * per-network throughput chart, keyed by interface id. */
  speedHistoryByInterface: Record<string, number[]>
  /** Highest combined speed seen so far this download — a rolling history window would lose it
   * once it ages out, so this is tracked as a running max instead. */
  peakSpeedBytesPerSec: number

  /** Lifted out of the Idle screen so it survives a swap to/from the No-connections screen. */
  draftUrl: string
  /** Persisted — the last folder picked, falling back to downloadsDir. */
  destinationDir: string
  /** Persisted — networks switched off on the start screen; the queue leaves them out too. */
  excludedNetworks: string[]

  /** The download queue, as the main process last sent it. Null until the first one arrives. */
  queue: QueueState | null
  queueOpen: boolean
  addLinksOpen: boolean
  /** The text the Add links dialog opened with — kept after it closes, so the dialog doesn't
   * empty out while it animates away. */
  addLinksDraft: string
  /** Counts openings: each one starts a fresh form. */
  addLinksKey: number

  /** Asks the main process for the network list now; it also pushes every change. */
  loadInterfaces: () => Promise<void>
  receiveInterfaces: (interfaces: NetworkInterfaceInfo[]) => void
  refreshLatencies: () => Promise<void>
  setNetworkPreference: (id: string, patch: NetworkPreference) => void
  setThemeSource: (source: ThemeSource) => void
  checkForUpdate: () => Promise<void>
  dismissUpdate: () => void
  /** A snapshot or an update of the current download, from the main process. */
  receiveDownloadUpdate: (update: DownloadUpdate) => void
  clearCurrentDownload: () => void
  setDraftUrl: (url: string) => void
  setDestinationDir: (dir: string) => void
  setExcludedNetworks: (ids: string[]) => void
  receiveQueue: (queue: QueueState) => void
  setQueueOpen: (open: boolean) => void
  openAddLinks: (text?: string) => void
  closeAddLinks: () => void
}

/** Which queue item each download was started for, as queue updates have shown it. Kept after
 * the item lets go of the download (one that failed with nothing worth keeping is removed at
 * once), so that download's screen still knows its item. */
const itemOfDownload = new Map<string, string>()

/** The queue item a download was started for, while that item is still in the queue. */
export function queueItemFor(downloadId: string): QueueItem | undefined {
  const itemId = itemOfDownload.get(downloadId)
  return itemId ? useAppStore.getState().queue?.items.find((item) => item.id === itemId) : undefined
}

// Settings saved by the main process, read once before the first paint (see InitialState).
const initial = window.plexo.initialState

/** Every setting changes optimistically: the store is updated first so the UI feels instant,
 * then this saves it. The store stays the source of truth either way — a failed save just means
 * the change isn't remembered next launch. */
function persist(patch: AppSettings): void {
  window.plexo.updateSettings(patch).catch(() => {})
}

export const useAppStore = create<AppStore>((set, get) => ({
  interfaces: [],
  interfacesStatus: 'idle',
  interfacesError: null,
  latencies: {},
  networkPreferences: initial.networkPreferences,
  themeSource: initial.themeSource,
  availableUpdate: null,

  homeDir: initial.homeDir,
  downloadsDir: initial.downloadsDir,

  currentDownload: null,
  speedHistory: [],
  speedHistoryByInterface: {},
  peakSpeedBytesPerSec: 0,

  draftUrl: '',
  destinationDir: initial.destinationDir ?? initial.downloadsDir,
  excludedNetworks: initial.excludedNetworks,

  queue: null,
  queueOpen: false,
  addLinksOpen: false,
  addLinksDraft: '',
  addLinksKey: 0,

  loadInterfaces: async () => {
    // A re-scan keeps showing the last result rather than flashing back to 'loading'.
    if (get().interfacesStatus !== 'ready') set({ interfacesStatus: 'loading' })
    set({ interfacesError: null })
    try {
      get().receiveInterfaces(await window.plexo.listInterfaces())
    } catch (error) {
      set({
        interfacesStatus: 'error',
        interfacesError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  receiveInterfaces: (interfaces) =>
    set({ interfaces, interfacesStatus: 'ready', interfacesError: null }),

  refreshLatencies: async () => {
    try {
      const latencies = await window.plexo.pingInterfaces()
      set({ latencies })
    } catch {
      // Latency is a nice-to-have readout — a failed probe just leaves stale values.
    }
  },

  // An explicit `undefined` in `patch` clears that field; main drops an entry left with neither.
  setNetworkPreference: (id, patch) => {
    const networkPreferences = {
      ...get().networkPreferences,
      [id]: { ...get().networkPreferences[id], ...patch }
    }
    set({ networkPreferences })
    persist({ networkPreferences })
  },

  setThemeSource: (themeSource) => {
    set({ themeSource })
    persist({ themeSource })
  },

  checkForUpdate: async () => {
    try {
      const availableUpdate = await window.plexo.checkForUpdate()
      set({ availableUpdate })
    } catch {
      // Best-effort — a failed check just leaves the banner hidden.
    }
  },

  dismissUpdate: () => {
    const update = get().availableUpdate
    if (!update) return
    // Keeps the update visible as a quiet titlebar icon rather than clearing it outright.
    set({ availableUpdate: { ...update, dismissed: true } })
    persist({ dismissedUpdateVersion: update.version })
  },

  receiveDownloadUpdate: (update) => {
    const previous = get().currentDownload
    const download = applyDownloadUpdate(previous, update)
    if (!download || download === previous) return
    // The last word of a queue download whose item was removed while it ran (cancelled from the
    // browser, say): the item went first, so there is nothing to show for it.
    const over = download.status === 'error' || download.status === 'cancelled'
    if (over && itemOfDownload.has(download.id) && !queueItemFor(download.id)) {
      if (previous?.id === download.id) get().clearCurrentDownload()
      return
    }
    const isNewDownload = !previous || previous.id !== download.id

    let speedHistory = isNewDownload ? [] : get().speedHistory
    let speedHistoryByInterface = isNewDownload ? {} : get().speedHistoryByInterface
    let peakSpeedBytesPerSec = isNewDownload ? 0 : get().peakSpeedBytesPerSec
    if (isNewDownload) lastSpeedSampleAt = 0

    if (download.status === 'downloading') {
      peakSpeedBytesPerSec = Math.max(peakSpeedBytesPerSec, download.speedBytesPerSec)

      const now = Date.now()
      if (now - lastSpeedSampleAt >= SPEED_SAMPLE_INTERVAL_MS) {
        lastSpeedSampleAt = now
        speedHistory = [...speedHistory, download.speedBytesPerSec].slice(-SPEED_HISTORY_LENGTH)

        const nextByInterface: Record<string, number[]> = {}
        for (const network of download.networks) {
          const previousSeries = speedHistoryByInterface[network.id] ?? []
          nextByInterface[network.id] = [...previousSeries, network.speedBytesPerSec].slice(
            -SPEED_HISTORY_LENGTH
          )
        }
        speedHistoryByInterface = nextByInterface
      }
    }

    set({ currentDownload: download, speedHistory, speedHistoryByInterface, peakSpeedBytesPerSec })
  },

  clearCurrentDownload: () =>
    set({
      currentDownload: null,
      speedHistory: [],
      speedHistoryByInterface: {},
      peakSpeedBytesPerSec: 0
    }),

  setDraftUrl: (draftUrl) => set({ draftUrl }),
  setDestinationDir: (destinationDir) => {
    set({ destinationDir })
    persist({ destinationDir })
  },

  setExcludedNetworks: (excludedNetworks) => {
    set({ excludedNetworks })
    persist({ excludedNetworks })
  },

  receiveQueue: (queue) => {
    for (const item of queue.items) {
      if (item.downloadId) itemOfDownload.set(item.downloadId, item.id)
    }
    set({ queue })
    // A failed or cancelled queue download on screen whose item has since been removed (here or
    // from the browser): its download went with it, so there is nothing left to show.
    const current = get().currentDownload
    const over = current?.status === 'error' || current?.status === 'cancelled'
    if (over && itemOfDownload.has(current.id) && !queueItemFor(current.id)) {
      get().clearCurrentDownload()
    }
  },
  setQueueOpen: (queueOpen) => set({ queueOpen }),
  openAddLinks: (text = '') =>
    set((store) => ({
      addLinksOpen: true,
      addLinksDraft: text,
      addLinksKey: store.addLinksKey + 1
    })),
  closeAddLinks: () => set({ addLinksOpen: false })
}))
