export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'
export type IpFamily = 4 | 6

export interface NetworkAddress {
  address: string
  family: IpFamily
  netmask?: string
  /** Used by the existing IPv4 same-subnet warning. */
  subnet?: string
}

export type ThemeSource = 'light' | 'dark'

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  addresses: NetworkAddress[]
  kind: NetworkInterfaceKind
  mac?: string
}

export interface ProbeResult {
  requestedUrl: string
  /** URL after following redirects — this is what the download should actually fetch. */
  finalUrl: string
  supportsRanges: boolean
  /** null when the server did not report a size. */
  totalBytes: number | null
  suggestedFileName: string
  contentType: string | null
  /** Strong validators, used to detect if the remote content changes between pause and resume. */
  etag: string | null
  lastModified: string | null
}

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** A stream's state. `pending` means it is waiting for work: it holds no block, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one (`currentBlockIndex` says which). A stream that fails for good leaves the list;
 * what went wrong is its network's to report (see DownloadNetwork). */
export type ChunkStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'cancelled'

/** One connection to the server, through one network. Streams come and go as the download
 * runs; what a network has done is kept on its DownloadNetwork. */
export interface ChunkState {
  id: number
  /** The network it runs on: a DownloadNetwork's id. */
  interfaceId: string
  rangeStart: number
  /** null means an open-ended range (download to end of file). */
  rangeEnd: number | null
  /** New bytes it has delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  status: ChunkStatus
  /** The block this stream is fetching. Unset whenever it holds none (idle, retrying, paused, done). */
  currentBlockIndex?: number
  /** True while this stream is racing another stream for `currentBlockIndex`, because that one
   * was too slow — see main/download/scheduler.ts. Whichever finishes first wins. */
  hedge?: boolean
}

export type BlockStatus = 'pending' | 'downloading' | 'completed'

export interface BlockState {
  index: number
  rangeStart: number
  rangeEnd: number | null
  status: BlockStatus
  /** The network currently leasing this block (or the last one to touch it). Only meaningful
   * as "who is working on it now" — for who actually *delivered* the bytes, read
   * `bytesByInterface`, since a block can be started on one network and finished on another
   * after a retry or a pause/resume. */
  interfaceId?: string
  bytesDownloaded: number
  /** Bytes of this block delivered by each network, keyed by interface id. Summing to
   * `bytesDownloaded`, this is what the block grid colors by, so a block split across
   * networks is attributed to all of them instead of only the one that happened to finish it. */
  bytesByInterface: Record<string, number>
}

/**
 * - on: in use.
 * - off: the user switched it off. A network that turns up mid-download starts off.
 * - offline: not connected to this computer. It's used again as soon as it is.
 * - unreachable: connected, but the server can't be reached through it. One connection keeps
 *   trying, and the rest follow once it gets through.
 * - failed: the server kept refusing requests over it (`error` says how). Switching it off and
 *   on, reconnecting it, or resuming tries again.
 */
export type NetworkStatus = 'on' | 'off' | 'offline' | 'unreachable' | 'failed'

/** A network as one download sees it: whether the user has it on, and how it is doing. */
export interface DownloadNetwork {
  /** A NetworkInterfaceInfo id. */
  id: string
  /** Its name and kind as the OS last reported them. */
  label: string
  kind: NetworkInterfaceKind
  /** The user's choice; `status` is what came of it. */
  enabled: boolean
  status: NetworkStatus
  error?: string
  /** Bytes of the file it delivered. */
  bytesDownloaded: number
  speedBytesPerSec: number
  /** Requests over it that failed and were tried again. */
  retries: number
}

export interface DownloadState {
  id: string
  url: string
  fileName: string
  destinationPath: string
  /** 0 means the size could not be determined ahead of time. */
  totalBytes: number
  bytesDownloaded: number
  speedBytesPerSec: number
  status: DownloadStatus
  /** Every network on this computer, and any the download used that has since gone, in the
   * order it first saw them. */
  networks: DownloadNetwork[]
  chunks: ChunkState[]
  /** The most streams it has run at once. */
  peakStreams?: number
  blocks?: BlockState[]
  totalBlocks?: number
  blockSizeBytes?: number
  error?: string
  /** For an error: whether resuming can pick up where it stopped. False when the progress was
   * thrown away, e.g. the file changed on the server. */
  resumable?: boolean
  startedAt: number
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** The update this state is as of (see DownloadUpdate). */
  seq?: number
}

/** What the main process sends as a download changes: everything but its blocks, and only the
 * blocks that changed since it last sent. A download can have tens of thousands of blocks, and
 * copying every one several times a second would cost the process that carries every byte. A
 * snapshot is the same with every block in it. */
export interface DownloadUpdate {
  /** Counts what the main process has sent for the download. A snapshot has the count it was
   * taken at. */
  seq: number
  state: Omit<DownloadState, 'blocks'>
  blocks: BlockState[]
}

/** User customization for one physical network, keyed by NetworkInterfaceInfo.id — lets a
 * cryptic OS device name (e.g. "feth0") get a real label, and a color distinct from its
 * kind's default. Persisted in the main process, independent of any single download. */
export interface NetworkPreference {
  customName?: string
  /** One of the app's curated swatch ids (see NETWORK_COLOR_SWATCHES) — not a raw hex, so every
   * swatch is guaranteed to have a legible on-solid text color already picked out for it. */
  colorId?: string
}

export type NetworkPreferences = Record<string, NetworkPreference>

export interface UpdateInfo {
  version: string
  /** Where clicking the notification should take the user — the landing page's downloads. */
  url: string
  /** True once the user has dismissed the banner for this exact version (persisted, so it stays
   * dismissed across relaunches) — the app then falls back to a quiet titlebar icon instead. */
  dismissed: boolean
}

/** What app-settings.json holds, and what the renderer sends to change it (merged over the saved
 * values, `undefined` clearing one). A missing field was never set. */
export interface AppSettings {
  themeSource?: ThemeSource
  dismissedUpdateVersion?: string
  /** The last destination folder picked. */
  destinationDir?: string
  /** User customizations (name/color) per network interface id. */
  networkPreferences?: NetworkPreferences
}

/** Everything the renderer needs for its first paint, read synchronously by the preload so no
 * saved value flashes in over a default a moment after launch. */
export interface InitialState {
  homeDir: string
  downloadsDir: string
  themeSource: ThemeSource
  networkPreferences: NetworkPreferences
  /** The last folder picked, if it still exists — otherwise the renderer uses downloadsDir. */
  destinationDir?: string
}

export interface StartDownloadRequest {
  url: string
  destinationDir: string
  suggestedFileName: string
  /** 0 means unknown. */
  totalBytes: number
  supportsRanges: boolean
  /** The networks to start on. Every other one starts switched off. */
  interfaceIds: string[]
  etag: string | null
  lastModified: string | null
  /** Optional custom headers (e.g. Cookie, Referer, User-Agent) forwarded to all chunk requests. */
  headers?: Record<string, string>
}

export interface CompanionDownloadPayload {
  url: string
  suggestedFileName?: string
  cookies?: string
  referer?: string
  userAgent?: string
  headers?: Record<string, string>
}
