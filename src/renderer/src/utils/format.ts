import type {
  DownloadNetwork,
  DownloadState,
  FinishedDownload,
  HttpDownloadNetwork,
  HttpDownloadState,
  SpeedUnit,
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

const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps']

/** Bits count in thousands, as internet plans and speed tests do — not the 1024s of formatBytes. */
export function formatSpeed(bytesPerSec: number, unit: SpeedUnit): string {
  if (unit === 'bytes') return `${formatBytes(bytesPerSec)}/s`
  const bits = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec * 8 : 0
  let exponent = bits < 1 ? 0 : Math.min(Math.floor(Math.log10(bits) / 3), BIT_UNITS.length - 1)
  // Whole numbers from 100 up: Mbps runs about 8x the digits of MB/s, so "943.2" would only jitter.
  const digits = (value: number): number => (exponent === 0 || value >= 99.95 ? 0 : 1)
  let value = bits / 1000 ** exponent
  if (exponent < BIT_UNITS.length - 1 && Number(value.toFixed(digits(value))) >= 1000) {
    exponent += 1
    value = bits / 1000 ** exponent
  }
  return `${value.toFixed(digits(value))} ${BIT_UNITS[exponent]}`
}

// Bytes a second in each unit formatSpeed reads in.
const SPEED_UNIT_BYTES: Record<string, number> = {
  'B/s': 1,
  'KB/s': 1024,
  'MB/s': 1024 ** 2,
  'GB/s': 1024 ** 3,
  'TB/s': 1024 ** 4,
  bps: 1 / 8,
  Kbps: 1e3 / 8,
  Mbps: 1e6 / 8,
  Gbps: 1e9 / 8,
  Tbps: 1e12 / 8
}

/** A speed axis for speeds up to `max`: 2 or 3 gridlines at round steps (1, 2, 2.5 or 5 × 10ⁿ) in
 * the unit formatSpeed would read `max` in, the top one just clearing it, each labelled with it. */
export function speedTicks(
  max: number,
  unit: SpeedUnit
): { top: number; ticks: { value: number; label: string }[] } {
  if (!(max > 0)) return { top: 1, ticks: [] }
  const label = formatSpeed(max, unit).split(' ')[1]
  const size = SPEED_UNIT_BYTES[label]
  const third = max / size / 3
  const power = 10 ** Math.floor(Math.log10(third))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= third)!
  const count = Math.ceil(max / size / step)
  const ticks = Array.from({ length: count }, (_, i) => {
    const value = Number(((i + 1) * step).toFixed(2))
    return { value: value * size, label: `${value} ${label}` }
  })
  return { top: count * step * size, ticks }
}

/** A speed someone set, as a round figure: whole from 10 up, never a trailing ".0". 58.7 Mbps
 * reads as something measured; 59 Mbps as something chosen. */
export function formatSpeedLimit(bytesPerSec: number, unit: SpeedUnit): string {
  const [value, label] = formatSpeed(bytesPerSec, unit).split(' ')
  const number = Number(value)
  return `${number >= 10 ? Math.round(number) : number} ${label}`
}

/** "11.7 of 50 GB": data used against a data limit, the unit said once when both share it. The
 * limit is a set figure, so no ".0" on it. */
export function formatDataUsage(used: number, limit: number): string {
  const max = formatBytes(limit).replace('.0 ', ' ')
  const [value, unit] = formatBytes(used).split(' ')
  return max.endsWith(` ${unit}`) ? `${value} of ${max}` : `${formatBytes(used)} of ${max}`
}

/** A speed against its limit, ["8.0", "10 MB/s"] for "8.0 / 10 MB/s": the unit said once
 * when both share it. Split so the limit can be set in a quieter color. No speed reads "—". */
export function formatSpeedOfLimit(
  bytesPerSec: number,
  limit: number,
  unit: SpeedUnit
): [string, string] {
  const max = formatSpeedLimit(limit, unit)
  if (bytesPerSec <= 0) return ['—', max]
  const speed = formatSpeed(bytesPerSec, unit)
  const [value, speedUnit] = speed.split(' ')
  return [max.endsWith(` ${speedUnit}`) ? value : speed, max]
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
