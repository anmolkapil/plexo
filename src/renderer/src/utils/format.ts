import type { ChunkState, NetworkInterfaceKind } from '@shared/types'

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

export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0 || remainingBytes <= 0) return '—'
  const seconds = remainingBytes / bytesPerSec
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))}s`
  const totalSec = Math.round(seconds)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

export function formatPercent(bytesDownloaded: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0
  return Math.min(100, Math.round((bytesDownloaded / totalBytes) * 100))
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Short uppercase file-type badge from a name's extension, e.g. "Xcode_16.2.xip" -> "XIP", "photo.jpeg" -> "JPEG". */
export function fileExtensionBadge(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return 'FILE'
  return fileName.slice(dotIndex + 1, dotIndex + 5).toUpperCase()
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

export interface NetworkGroup {
  interfaceId: string
  interfaceLabel: string
  interfaceKind: NetworkInterfaceKind
  chunks: ChunkState[]
  bytesDownloaded: number
  speedBytesPerSec: number
}

/** Chunks are the unit of transfer, but a physical network is the unit the user thinks and
 * decides in — a network can carry several chunks (via "chunks per network", or ones split
 * off by dynamic rebalancing). Groups chunks by their interface, in order of first appearance,
 * with per-network totals so the UI can show one row per physical network. */
export function groupChunksByInterface(chunks: ChunkState[]): NetworkGroup[] {
  const order: string[] = []
  const groups = new Map<string, NetworkGroup>()

  for (const chunk of chunks) {
    let group = groups.get(chunk.interfaceId)
    if (!group) {
      group = {
        interfaceId: chunk.interfaceId,
        interfaceLabel: chunk.interfaceLabel,
        interfaceKind: chunk.interfaceKind,
        chunks: [],
        bytesDownloaded: 0,
        speedBytesPerSec: 0
      }
      groups.set(chunk.interfaceId, group)
      order.push(chunk.interfaceId)
    }
    group.chunks.push(chunk)
    group.bytesDownloaded += chunk.bytesDownloaded
    group.speedBytesPerSec += chunk.speedBytesPerSec
  }

  return order.map((interfaceId) => groups.get(interfaceId)!)
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

const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const NESTED_ERROR_PREFIX = /^Error:\s*/

const ERROR_HINTS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /parts never finished/,
    message:
      'The download never fully finished, so Plexo couldn’t assemble it. Try downloading again.'
  },
  {
    pattern: /refusing to write a corrupt file/,
    message:
      'One of the downloaded pieces didn’t match its expected size, so Plexo stopped rather than save a corrupted file. Try downloading again.'
  },
  {
    pattern: /refusing to keep a corrupt file/,
    message:
      'The assembled file didn’t match its expected size, so Plexo removed it rather than keep a corrupted file. Try downloading again.'
  },
  {
    pattern: /Proxy authentication required|HTTP 407/i,
    message: 'Proxy authentication failed — check your proxy username and password.'
  },
  {
    pattern: /SOCKS5 authentication failed/i,
    message: 'SOCKS5 proxy authentication failed — check your username and password.'
  },
  {
    pattern: /Connecting to proxy .* timed out/i,
    message: 'Connecting to proxy timed out — check the proxy host, port, and your network.'
  },
  {
    pattern: /Proxy CONNECT failed/i,
    message: 'The HTTP proxy rejected the connection request.'
  },
  {
    pattern: /SOCKS[45] connection (?:rejected|failed)/i,
    message: 'The SOCKS proxy rejected the connection — check your proxy settings.'
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/,
    message: 'Could not resolve that host — check the URL and your connection.'
  },
  {
    pattern: /ECONNREFUSED/,
    message: 'The server refused the connection — it may be down or blocking requests.'
  },
  {
    pattern: /ECONNRESET|socket hang up/,
    message: 'The connection was reset by the server — try again in a moment.'
  },
  {
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/,
    message: 'The connection timed out — check your network and try again.'
  },
  {
    pattern: /CERT|SSL|TLS/i,
    message: "The server's security certificate could not be verified."
  },
  {
    pattern: /Invalid URL|ERR_INVALID_URL/,
    message: 'That doesn’t look like a valid URL.'
  },
  {
    pattern: /Server responded with status 401/,
    message: 'This link requires you to sign in — Plexo can’t download it.'
  },
  {
    pattern: /Server responded with status 403/,
    message: 'Access to this file was denied by the server.'
  },
  {
    pattern: /Server responded with status 404/,
    message: 'That file could not be found — check the link and try again.'
  },
  {
    pattern: /Server responded with status 4\d\d/,
    message: 'The server rejected this request — check the link and try again.'
  },
  {
    pattern: /Server responded with status 5\d\d/,
    message: 'The server is having trouble right now — try again later.'
  }
]

/** Electron wraps a rejected IPC call as "Error invoking remote method 'x': Error: <message>" —
 * strip that framework noise and translate common network errors and internal consistency-check
 * failures into plain English. Used for both the pre-download probe and a download's own
 * `error` field, so a failure partway through a transfer reads exactly as friendly as one caught
 * before it started. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(IPC_INVOKE_PREFIX, '').replace(NESTED_ERROR_PREFIX, '')

  for (const { pattern, message } of ERROR_HINTS) {
    if (pattern.test(stripped)) return message
  }

  return stripped
}
