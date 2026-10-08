import { applyDownloadUpdate } from '@shared/downloadUpdate'
import type {
  AppSettings,
  DownloadState,
  DownloadUpdate,
  FinishedDownload,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  PendingLink,
  SpeedUnit,
  ThemeSource,
  UpdateInfo
} from '@shared/types'
import { create } from 'zustand'

export type DownloadFilter = 'all' | 'progress' | 'finished' | 'failed'

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** What the window shows: the list of downloads, or one download. */
export type View = { name: 'list' } | { name: 'download'; id: string }

interface AppStore {
  interfaces: NetworkInterfaceInfo[]
  interfacesStatus: LoadStatus
  interfacesError: string | null
  /** User customizations (name/color) per network interface id — persisted in the main process. */
  networkPreferences: NetworkPreferences

  /** Persisted in the main process alongside nativeTheme.themeSource. */
  themeSource: ThemeSource

  /** Null until the one-time startup check resolves, or if it found nothing worth showing
   * (already up to date, already dismissed, or the check failed). */
  availableUpdate: UpdateInfo | null

  homeDir: string
  downloadsDir: string

  /** Every download that isn't finished, by id — running, queued, paused or failed. */
  downloads: Record<string, DownloadState>
  /** Finished downloads, newest first (see main/download/history.ts). */
  history: FinishedDownload[]
  view: View
  downloadFilter: DownloadFilter
  setDownloadFilter: (filter: DownloadFilter) => void
  /** The New download dialog, over whatever the window shows. */
  newDownloadOpen: boolean
  /** Persisted — how many downloads run at once; the rest wait in the queue. */
  downloadsAtOnce: number
  /** Persisted — the speed limits (see AppSettings). */
  speedLimit: number | undefined
  slowMode: boolean
  slowModeSpeed: number
  /** Persisted — MB/s or Mbps, for every speed shown. */
  speedUnit: SpeedUnit

  /** Lifted out of the Idle screen so it survives a swap to/from the No-connections screen. */
  draftUrl: string
  /** Handed-over links stacked in New download, oldest first. */
  links: PendingLink[]
  /** -1 while New download shows a link typed or pasted there instead. */
  linkIndex: number
  /** Bumped to remount New download's form for another link. */
  formKey: number
  /** The link last started: still on the clipboard afterwards, so not offered again. */
  startedUrl: string
  /** Persisted — the last folder picked, falling back to downloadsDir. */
  destinationDir: string

  /** Asks the main process for the network list now; it also pushes every change. */
  loadInterfaces: () => Promise<void>
  receiveInterfaces: (interfaces: NetworkInterfaceInfo[]) => void
  setNetworkPreference: (id: string, patch: NetworkPreference) => void
  setThemeSource: (source: ThemeSource) => void
  checkForUpdate: () => Promise<void>
  dismissUpdate: () => void
  /** A snapshot or an update of a download, from the main process. */
  receiveDownloadUpdate: (update: DownloadUpdate) => void
  /** Finished downloads as main lists them; any that finished leave `downloads`. */
  receiveHistory: (history: FinishedDownload[]) => void
  /** Removes a download (cancelling one under way), or forgets a finished one. */
  removeDownload: (id: string, options?: { trashFile?: boolean }) => void
  setView: (view: View) => void
  /** Opens New download, with `link` in its link field when one is given. */
  openNewDownload: (link?: string) => void
  closeNewDownload: () => void
  receiveLinks: () => Promise<void>
  showLink: (index: number) => void
  finishLink: (started: boolean) => void
  /** Another link was typed over the shown one: the field keeps what was typed. */
  letShownLinkGo: () => void
  setDownloadsAtOnce: (count: number) => void
  /** Each one applies at once, to every download (see main/network/limits.ts). */
  setSpeedLimit: (bytesPerSec: number | undefined) => void
  setSlowMode: (on: boolean) => void
  setSlowModeSpeed: (bytesPerSec: number) => void
  setSpeedUnit: (unit: SpeedUnit) => void
  setDraftUrl: (url: string) => void
  setDestinationDir: (dir: string) => void
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
  networkPreferences: initial.networkPreferences,
  themeSource: initial.themeSource,
  availableUpdate: null,

  homeDir: initial.homeDir,
  downloadsDir: initial.downloadsDir,

  downloads: {},
  history: [],
  view: { name: 'list' },
  downloadFilter: 'all',
  setDownloadFilter: (downloadFilter) => set({ downloadFilter }),
  newDownloadOpen: false,
  downloadsAtOnce: initial.downloadsAtOnce,
  speedLimit: initial.speedLimit,
  slowMode: initial.slowMode,
  slowModeSpeed: initial.slowModeSpeed,
  speedUnit: initial.speedUnit,

  draftUrl: '',
  links: [],
  linkIndex: -1,
  formKey: 0,
  startedUrl: '',
  destinationDir: initial.destinationDir ?? initial.downloadsDir,

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
    const { downloads, history } = get()
    // Finished already: an update that arrives late mustn't bring it back.
    if (history.some((entry) => entry.id === update.state.id)) return
    const previous = downloads[update.state.id] ?? null
    const download = applyDownloadUpdate(previous, update)
    if (!download || download === previous) return
    set({ downloads: { ...downloads, [download.id]: download } })
  },

  receiveHistory: (history) => {
    const downloads = { ...get().downloads }
    for (const entry of history) delete downloads[entry.id]
    set({ history, downloads })
  },

  removeDownload: (id, options) => {
    const { [id]: removed, ...downloads } = get().downloads
    void removed
    set({ downloads, history: get().history.filter((entry) => entry.id !== id) })
    void window.plexo.removeDownload(id, options).catch(() => {})
  },

  setView: (view) => set({ view }),

  openNewDownload: (link) =>
    set(link === undefined ? { newDownloadOpen: true } : { newDownloadOpen: true, draftUrl: link }),

  closeNewDownload: () => {
    const { links, linkIndex } = get()
    if (linkIndex >= 0) return get().finishLink(false)
    if (links.length > 0) return get().showLink(links.length - 1)
    set({ newDownloadOpen: false })
  },

  receiveLinks: async () => {
    // main hands each link over only once, so overlapping calls can't take the same one.
    const arrived = await window.plexo.takePendingLinks().catch(() => [])
    if (arrived.length === 0) return
    const links = [...get().links, ...arrived]
    set({ links, newDownloadOpen: true })
    get().showLink(links.length - 1)
  },

  showLink: (index) => {
    const link = get().links[index]
    if (link) set({ linkIndex: index, draftUrl: link.url, formKey: get().formKey + 1 })
  },

  finishLink: (started) => {
    const { links, linkIndex } = get()
    const link = links[linkIndex]
    if (!link) return
    // Started, main has already forgotten its sign-in.
    if (!started) void window.plexo.dismissLink(link.id).catch(() => {})
    const left = links.filter((_, index) => index !== linkIndex)
    set({ links: left, linkIndex: -1, draftUrl: '' })
    if (left.length > 0) get().showLink(left.length - 1)
    else set({ newDownloadOpen: false })
  },

  letShownLinkGo: () => {
    const { links, linkIndex } = get()
    const link = links[linkIndex]
    if (!link) return
    void window.plexo.dismissLink(link.id).catch(() => {})
    set({ links: links.filter((_, index) => index !== linkIndex), linkIndex: -1 })
  },

  setDownloadsAtOnce: (downloadsAtOnce) => {
    set({ downloadsAtOnce })
    persist({ downloadsAtOnce })
  },

  setSpeedLimit: (speedLimit) => {
    set({ speedLimit })
    persist({ speedLimit })
  },

  setSlowMode: (slowMode) => {
    set({ slowMode })
    persist({ slowMode })
  },

  setSlowModeSpeed: (slowModeSpeed) => {
    set({ slowModeSpeed })
    persist({ slowModeSpeed })
  },

  setSpeedUnit: (speedUnit) => {
    set({ speedUnit })
    persist({ speedUnit })
  },

  setDraftUrl: (draftUrl) => set({ draftUrl }),
  setDestinationDir: (destinationDir) => {
    set({ destinationDir })
    persist({ destinationDir })
  }
}))
