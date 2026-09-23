export type NetworkInterfaceKind = 'wifi' | 'usb' | 'ethernet' | 'bridge' | 'other'

export type ThemeSource = 'light' | 'dark'

export interface NetworkInterfaceInfo {
  /** Stable identifier for this interface (currently the OS device name, e.g. "en0"). */
  id: string
  device: string
  displayName: string
  address: string
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

export type DownloadStatus =
  'downloading' | 'assembling' | 'paused' | 'completed' | 'error' | 'cancelled'

/** A stream's state. `pending` means it is waiting for work: it holds no block, either because
 * none is free for it right now or because it hasn't started. `downloading` always means it is
 * fetching one (`currentBlockIndex` says which). */
export type ChunkStatus =
  'pending' | 'downloading' | 'retrying' | 'paused' | 'completed' | 'error' | 'cancelled'

export interface ChunkState {
  id: number
  interfaceId: string
  interfaceLabel: string
  interfaceKind: NetworkInterfaceKind
  rangeStart: number
  /** null means an open-ended range (download to end of file). */
  rangeEnd: number | null
  bytesDownloaded: number
  speedBytesPerSec: number
  status: ChunkStatus
  error?: string
  /** Number of times this chunk's connection has been retried after a dropped/failed attempt. */
  retryCount: number
  /** The block this stream is fetching. Unset whenever it holds none (idle, retrying, paused, done). */
  currentBlockIndex?: number
  /** True while this stream is racing another stream for `currentBlockIndex`, because that one
   * was too slow — see main/download/scheduler.ts. Whichever finishes first wins. */
  hedge?: boolean
}

export type BlockStatus = 'pending' | 'downloading' | 'completed' | 'error'

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
  chunks: ChunkState[]
  blocks?: BlockState[]
  totalBlocks?: number
  blockSizeBytes?: number
  error?: string
  startedAt: number
  pausedAt?: number
  totalPausedMs?: number
  completedAt?: number
  /** Bytes written to the destination file so far while `status` is 'assembling' — the part
   * files are already all complete at that point, so this tracks the sequential reassembly step
   * rather than the network transfer. */
  assembledBytes?: number
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

/** One fake network in a dev-tool "virtual download" — see SimulatedNetworkConfig callers in
 * main/download/simDownload.ts. Lets a developer exercise the multi-network UI (the block grid,
 * per-network speed/throughput, retries, errors, assembling) against a file already on disk,
 * without needing a real flaky connection or a slow remote server to test against. */
export interface SimulatedNetworkConfig {
  kind: NetworkInterfaceKind
  label: string
  /** Target sustained throughput for this simulated network, in bytes/sec. */
  speedBytesPerSec: number
  /** 0-100 chance a chunk attempt on this network fails outright, simulating a dropped
   * connection — set above 0 to exercise the retry/error UI on demand. */
  faultRatePercent: number
}

export interface StartSimulatedDownloadRequest {
  /** Absolute path to a file already on disk — this is what gets "downloaded". */
  sourceFilePath: string
  destinationDir: string
  networks: SimulatedNetworkConfig[]
  chunkCount: number
  connectionsPerNetwork?: number
  /** Throttles the reassembly step to this many bytes/sec, so the 'assembling' phase's UI (the
   * block grid sweep, the combine diagram) stays visible long enough to watch even on a small
   * file that would otherwise reassemble in a single tick. Omitted or 0 assembles at full disk
   * speed, same as a real download. */
  assembleSpeedBytesPerSec?: number
}

export interface UpdateInfo {
  version: string
  /** Where clicking the notification should take the user — the landing page's downloads. */
  url: string
  /** True once the user has dismissed the banner for this exact version (persisted, so it stays
   * dismissed across relaunches) — the app then falls back to a quiet titlebar icon instead. */
  dismissed: boolean
}

export interface InitialPaths {
  homeDir: string
  downloadsDir: string
  /** True in electron-vite's dev server, false in a packaged build — gates the dev tools panel. */
  isDev: boolean
}

export interface StartDownloadRequest {
  url: string
  destinationDir: string
  suggestedFileName: string
  /** 0 means unknown. */
  totalBytes: number
  supportsRanges: boolean
  interfaceIds: string[]
  /** Total chunks to split the download into across interfaceIds. */
  chunkCount: number
  /** Number of parallel connections allocated per physical network. */
  connectionsPerNetwork?: number
  etag: string | null
  lastModified: string | null
}
