import type {
  AppSettings,
  DownloadUpdate,
  FinishedDownload,
  NetworkInterfaceInfo,
  PendingLink,
  ProbeResult,
  StartDownloadRequest,
  TorrentFileEntry,
  UpdateInfo
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the
 * main->renderer push events, downloadUpdated, networksChanged, historyChanged and linkReceived) — one source of truth for
 * both plexoApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  updateSettings: { args: [patch: AppSettings]; result: void }
  probeUrl: { args: [url: string]; result: ProbeResult }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  chooseTorrentFile: { args: []; result: string | null }
  readClipboardText: { args: []; result: string }
  /** Shows a download's file in its folder, by the download's own path. False when nothing is
   * there any more: history is re-sent, with it marked missing. */
  revealDownload: { args: [id: string]; result: boolean }
  /** Opens a download's file (a torrent's folder) with the OS default. False when it's gone or
   * nothing could open it. */
  openDownload: { args: [id: string]; result: boolean }
  /** `linkId`: the PendingLink whose browser sign-in it starts with. */
  startDownload: { args: [request: StartDownloadRequest, linkId?: string]; result: string }
  /** Every download, oldest first, each as a snapshot. */
  listDownloads: { args: []; result: DownloadUpdate[] }
  /** Finished downloads, newest first. One is forgotten with removeDownload. */
  listHistory: { args: []; result: FinishedDownload[] }
  /** Forgets every finished download; their files stay. */
  clearHistory: { args: []; result: void }
  /** Bytes each network has received in its selected calendar period, by id (see NetworkPreference.dataLimit). */
  networkUsage: { args: []; result: Record<string, number> }
  resetNetworkUsage: { args: [id: string]; result: void }
  /** Bytes free on the drive holding `dir`; null when it can't be told. */
  freeSpace: { args: [dir: string]; result: number | null }
  /** A torrent download's files, in the torrent's order; empty for any other download. */
  torrentFiles: { args: [id: string]; result: TorrentFileEntry[] }
  /** Which of a torrent download's files to fetch, by index, as it runs or not. Refused for one
   * already downloaded, or with no room on disk for what's added. */
  chooseTorrentFiles: { args: [id: string, selected: number[]]; result: void }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  /** A fresh link to the same file, for a download whose link stopped working; it resumes. */
  relinkDownload: { args: [id: string, url: string]; result: void }
  setDownloadNetwork: { args: [id: string, networkId: string, enabled: boolean]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  /** Removes a download, cancelling one under way. A finished one's file stays, unless
   * `trashFile`: then it goes to the Trash. */
  removeDownload: { args: [id: string, options?: { trashFile?: boolean }]; result: void }
  checkForUpdate: { args: []; result: UpdateInfo | null }
  /** Oldest first: every link not yet started or dismissed. */
  pendingLinks: { args: []; result: PendingLink[] }
  /** Resumes the failed download a link was matched to, from that link (see relinkDownload). */
  resumeFromLink: { args: [linkId: string, downloadId: string]; result: void }
  /** Forgets the sign-in of a link that won't be started. */
  dismissLink: { args: [id: string]; result: void }
}
