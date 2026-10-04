import type {
  DownloadNetwork,
  DownloadState,
  FinishedDownload,
  HttpDownloadNetwork,
  HttpDownloadState,
  TorrentDownloadNetwork,
  TorrentDownloadState
} from '@shared/types'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  let value = bytes / 1024 ** exponent
  if (exponent < UNITS.length - 1 && Number(value.toFixed(exponent === 0 ? 0 : 1)) >= 1024) {
    exponent += 1
    value = bytes / 1024 ** exponent
  }
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${UNITS[exponent]}`
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`
  const totalSec = Math.round(seconds)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

/** "3 files", or "2 of 4 files" when only some were chosen. */
export function describeFileCount(chosen: number, total: number): string {
  const files = `${total} ${total === 1 ? 'file' : 'files'}`
  return chosen === total ? files : `${chosen} of ${files}`
}

/** A torrent file's path within the torrent's own folder, which every path starts with. */
export function pathInTorrent(path: string): string {
  return path.split(/[\\/]/).slice(1).join('/') || path
}

/** What a download fetches: all of it, bar a torrent's pieces no chosen file needs. */
export function wantedBytes(download: DownloadState | FinishedDownload): number {
  return download.totalBytes - (download.kind === 'torrent' ? download.skippedBytes : 0)
}

export function formatPercent(bytesDownloaded: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0
  return Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Short uppercase file-type badge from a name's extension, e.g. "Xcode_16.2.xip" -> "XIP", "photo.jpeg" -> "JPEG". */
/** A download that is a folder: a torrent's, of its files. */
export function isFolder(download: DownloadState | FinishedDownload): boolean {
  return download.kind === 'torrent' && download.folder
}

export function fileExtensionBadge(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return 'FILE'
  return fileName.slice(dotIndex + 1, dotIndex + 5).toUpperCase()
}

/** When something happened, as a list shows it: "Just now", "12 min ago", "Today 08:55",
 * "Yesterday 21:10", or the date. */
export function formatWhen(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const date = new Date(time)
  const clock = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const days = Math.round(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(time).setHours(0, 0, 0, 0)) / 86_400_000
  )
  if (days === 0) return `Today ${clock}`
  if (days === 1) return `Yesterday ${clock}`
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** What Plexo can download: a web link, a magnet link, or a .torrent file on this computer. */
export function acceptedLink(text: string): string | null {
  const link = text.trim()
  if (/^(https?:\/\/|magnet:\?)/i.test(link)) return link
  if (/^(\/|[a-z]:\\).*\.torrent$/i.test(link)) return link
  return null
}

/** Where a link's download comes from, in a word: its host. */
export function sourceOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** m:ss, or h:mm:ss past an hour. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.max(0, Math.round(seconds))
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/** "12.3 MB" -> { value: "12.3", unit: "MB" } — for readouts that size the number and unit separately. */
export function splitFormattedBytes(bytes: number): { value: string; unit: string } {
  const [value, unit] = formatBytes(bytes).split(' ')
  return { value, unit }
}

export function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (index < 0) return '.'
  if (index === 0 || (index === 2 && path[1] === ':')) return path.slice(0, index + 1)
  return path.slice(0, index)
}

export interface HttpNetworkGroup extends HttpDownloadNetwork {
  streams: HttpDownloadState['streams']
}

export interface TorrentNetworkGroup extends TorrentDownloadNetwork {
  peers: TorrentDownloadState['peers']
}

export type NetworkGroup = HttpNetworkGroup | TorrentNetworkGroup

export function groupByNetwork(download: DownloadState): NetworkGroup[] {
  if (download.kind === 'http') {
    return download.networks.map((network) => ({
      ...network,
      streams: download.streams.filter((stream) => stream.interfaceId === network.id)
    }))
  }
  return download.networks.map((network) => ({
    ...network,
    peers: download.peers.filter((peer) => peer.interfaceId === network.id)
  }))
}

/** The networks worth drawing in a download's charts and legends: the ones in use, and any that
 * carried part of the file. */
export function networksInPlay<T extends DownloadNetwork>(networks: T[]): T[] {
  return networks.filter((network) => network.enabled || network.bytesDownloaded > 0)
}

/** Shortens an absolute path under the user's home directory to a "~/..." form for display. */
export function toDisplayPath(path: string, homeDir: string): string {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '')
    return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
      ? normalized.toLowerCase()
      : normalized
  }
  const home = normalize(homeDir)
  const target = normalize(path)
  if (home && (target === home || target.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }
  return path
}

export { describeError } from '@shared/errors'

const LINK_REFUSED = /status (401|403|404|410) for range request/

/** A download whose link the server now refuses: a fresh link to the same file picks it up. */
export function linkExpired(download: DownloadState): boolean {
  return (
    download.kind === 'http' &&
    download.status === 'error' &&
    LINK_REFUSED.test(download.error ?? '')
  )
}
