/* eslint-disable @typescript-eslint/no-explicit-any */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import type { ProbeResult } from '../../shared/types'
import { testKnobs } from '../testKnobs'

const MAX_REDIRECTS = 5
const USER_AGENT = 'Plexo/1.0'
// A server that accepts the connection and never answers would otherwise hang the probe — and
// the link field's "Checking…" — forever. Same budget as a stalled chunk.
const PROBE_TIMEOUT_MS = testKnobs.stallTimeoutMs

type Headers = Record<string, string | string[] | undefined>

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

interface ProbeResponse {
  statusCode: number
  headers: Headers
}

/** GET with a 1-byte range: cheaper than fetching the body, and unlike HEAD it
 * also tells us (via the 206 status) whether range requests actually work. */
function requestOneByte(url: URL): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' }
      },
      (res) => {
        res.destroy()
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as Headers })
      }
    )
    req.on('error', reject)
    req.setTimeout(PROBE_TIMEOUT_MS, () =>
      req.destroy(new Error('The server did not respond — check the link and try again'))
    )
    req.end()
  })
}

function parseContentDispositionFilename(disposition: string): string | null {
  // RFC 6266 / RFC 5987: filename* takes precedence over filename
  // format: filename*=charset'language'encoded-value
  const extMatch = /\bfilename\*=(?:[a-zA-Z0-9_-]+)'[^']*'([^;\s]+)/i.exec(disposition)
  if (extMatch?.[1]) {
    try {
      return decodeURIComponent(extMatch[1])
    } catch {
      return extMatch[1]
    }
  }

  // Quoted string: preserves semicolons inside quotes, e.g. filename="report; final.pdf"
  const quotedMatch = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(disposition)
  if (quotedMatch?.[1]) {
    const unescaped = quotedMatch[1].replace(/\\(.)/g, '$1')
    try {
      return decodeURIComponent(unescaped)
    } catch {
      return unescaped
    }
  }

  // Unquoted token fallback
  const tokenMatch = /\bfilename=([^;\s]+)/i.exec(disposition)
  if (tokenMatch?.[1]) {
    try {
      return decodeURIComponent(tokenMatch[1])
    } catch {
      return tokenMatch[1]
    }
  }

  return null
}

function fileNameFromHeaders(headers: Headers, url: URL): string {
  const disposition = headerValue(headers, 'content-disposition')
  if (disposition) {
    const parsed = parseContentDispositionFilename(disposition)
    if (parsed) return parsed
  }
  let pathname = url.pathname
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // A malformed %-escape: the raw path still names the file well enough.
  }
  const base = pathname.split('/').filter(Boolean).pop()
  return base && base.length > 0 ? base : 'download'
}

async function requestFollowingRedirects(
  rawUrl: string
): Promise<{ current: URL; response: ProbeResponse | null }> {
  let current = new URL(rawUrl)
  let response: ProbeResponse | null = null

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await requestOneByte(current)
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = headerValue(response.headers, 'location')
      if (!location) break
      current = new URL(location, current)
      continue
    }
    break
  }

  return { current, response }
}

export function isMagnetUrl(rawUrl: string): boolean {
  const sanitized = rawUrl.trim().replace(/^["']|["']$/g, '')
  return sanitized.toLowerCase().startsWith('magnet:')
}

export function parseMagnetUrl(rawUrl: string): ProbeResult {
  const sanitized = rawUrl.trim().replace(/^["']|["']$/g, '')
  const searchIndex = sanitized.indexOf('?')
  const queryStr = searchIndex !== -1 ? sanitized.slice(searchIndex) : ''
  const searchParams = new URLSearchParams(queryStr)

  const xtList = searchParams.getAll('xt')
  let validXt = xtList.find((xt) => /^urn:btih:/i.test(xt) || /^urn:btmh:/i.test(xt))

  if (!validXt && /urn:btih:|urn:btmh:/i.test(sanitized)) {
    const match = /(urn:bt[ih|mh]:[a-zA-Z0-9]+)/i.exec(sanitized)
    if (match) {
      validXt = match[1]
    }
  }

  if (!validXt) {
    throw new Error('Invalid magnet URI: missing or invalid info hash (xt parameter)')
  }

  const parts = validXt.split(':')
  const infoHash = parts[parts.length - 1] || ''

  if (!infoHash || !/^([a-fA-F0-9]{40}|[2-7a-zA-Z]{32}|[a-fA-F0-9]{64})$/i.test(infoHash)) {
    throw new Error('Invalid magnet URI: missing or invalid info hash (xt parameter)')
  }

  const dn = searchParams.get('dn')
  let suggestedFileName = dn ? dn.trim() : ''

  if (!suggestedFileName) {
    const dnMatch = /[?&]dn=([^&]+)/i.exec(sanitized)
    if (dnMatch) {
      try {
        suggestedFileName = decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')).trim()
      } catch {
        suggestedFileName = dnMatch[1].replace(/\+/g, ' ').trim()
      }
    }
  }

  if (!suggestedFileName) {
    suggestedFileName = infoHash ? `magnet-${infoHash.slice(0, 8)}` : 'download'
  }

  const xl = searchParams.get('xl') || (/[?&]xl=(\d+)/i.exec(sanitized)?.[1] ?? null)
  let totalBytes: number | null = null
  if (xl && /^\d+$/.test(xl)) {
    const parsedSize = parseInt(xl, 10)
    if (!isNaN(parsedSize) && parsedSize >= 0) {
      totalBytes = parsedSize
    }
  }

  return {
    requestedUrl: sanitized,
    finalUrl: sanitized,
    supportsRanges: true,
    totalBytes,
    suggestedFileName,
    contentType: 'application/x-bittorrent',
    etag: null,
    lastModified: null
  }
}

async function getWebTorrent(): Promise<any> {
  try {
    const mod = await import('webtorrent')
    return mod.default || mod
  } catch {
    return null
  }
}

export async function resolveMagnetMetadata(
  magnetUrl: string,
  timeoutMs = 4000
): Promise<{ name?: string; length?: number } | null> {
  return new Promise((resolve) => {
    let client: any = null
    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (client) {
        try {
          client.destroy()
        } catch {
          // ignore
        }
      }
    }

    timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)

    getWebTorrent()
      .then((WebTorrent) => {
        if (!WebTorrent || timer === null) {
          cleanup()
          resolve(null)
          return
        }
        client = new WebTorrent()
        client.add(magnetUrl, { destroyStoreOnDestroy: true }, (torrent: any) => {
          const name = torrent.name
          const length = torrent.length
          cleanup()
          resolve({ name, length })
        })
        client.on('error', () => {
          cleanup()
          resolve(null)
        })
      })
      .catch(() => {
        cleanup()
        resolve(null)
      })
  })
}

export async function probeUrl(rawUrl: string): Promise<ProbeResult> {
  if (isMagnetUrl(rawUrl)) {
    const syncResult = parseMagnetUrl(rawUrl)
    try {
      const meta = await resolveMagnetMetadata(rawUrl, 4000)
      if (meta) {
        if (meta.name) syncResult.suggestedFileName = meta.name
        if (typeof meta.length === 'number' && meta.length > 0) {
          syncResult.totalBytes = meta.length
        }
      }
    } catch {
      // Fall back to parsed magnet URL parameters if metadata resolution times out
    }
    return syncResult
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new Error(
      'Invalid URL format. Please provide a valid http://, https://, or magnet: link.'
    )
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Unsupported protocol '${parsedUrl.protocol}'. Supported protocols are http:, https:, and magnet:.`
    )
  }

  const { current, response } = await requestFollowingRedirects(rawUrl)

  // An empty file can't satisfy a request for its first byte: the server answers 416 and gives
  // the size as `bytes */0`. That's a valid, empty download, not an error.
  if (
    response?.statusCode === 416 &&
    /^\s*bytes\s+\*\/0\s*$/i.test(headerValue(response.headers, 'content-range') ?? '')
  ) {
    return {
      requestedUrl: rawUrl,
      finalUrl: current.toString(),
      supportsRanges: false,
      totalBytes: 0,
      suggestedFileName: fileNameFromHeaders(response.headers, current),
      contentType: headerValue(response.headers, 'content-type') ?? null,
      etag: headerValue(response.headers, 'etag') ?? null,
      lastModified: headerValue(response.headers, 'last-modified') ?? null
    }
  }

  if (!response || response.statusCode === 0 || response.statusCode >= 400) {
    throw new Error(`Server responded with status ${response?.statusCode || 'unknown'}`)
  }

  const contentRange = headerValue(response.headers, 'content-range')
  // A server that supports range requests must answer our 1-byte range GET with 206 Partial Content.
  // If it returned 200 OK, it ignored the Range header and sent the whole file — even if its headers
  // statically claim `Accept-Ranges: bytes`.
  const supportsRanges = response.statusCode === 206

  let totalBytes: number | null = null
  if (contentRange) {
    const match = /\/(\d+)$/.exec(contentRange)
    if (match) totalBytes = Number(match[1])
  }
  if (totalBytes === null && response.statusCode === 200) {
    // Only trust Content-Length on a full (200) response — on a 206 it
    // describes the single byte we asked for, not the whole file.
    const contentLength = headerValue(response.headers, 'content-length')
    if (contentLength) totalBytes = Number(contentLength)
  }

  return {
    requestedUrl: rawUrl,
    finalUrl: current.toString(),
    supportsRanges,
    totalBytes,
    suggestedFileName: fileNameFromHeaders(response.headers, current),
    contentType: headerValue(response.headers, 'content-type') ?? null,
    etag: headerValue(response.headers, 'etag') ?? null,
    lastModified: headerValue(response.headers, 'last-modified') ?? null
  }
}
