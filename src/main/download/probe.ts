import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isAbsolute } from 'node:path'
import { URL } from 'node:url'
import type { ProbeResult } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import {
  describeTorrent,
  downloadTorrentFile,
  fetchMagnetMetadata,
  readTorrentFile
} from './torrent/metadata'

const MAX_REDIRECTS = 5
const USER_AGENT = 'Plexo/1.0'
// A server that accepts the connection and never answers would otherwise hang the probe — and
// the link field's "Checking…" — forever. Same budget as a stalled chunk, for the whole probe:
// redirects included, so a chain of slow hops can't stretch it.
const PROBE_TIMEOUT_MS = testKnobs.stallTimeoutMs
const NO_RESPONSE = 'The server did not respond — check the link and try again'

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
function requestOneByte(url: URL, deadline: number): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(
      {
        method: 'GET',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' }
      },
      (res) => {
        clearTimeout(timer)
        res.destroy()
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as Headers })
      }
    )
    const timer = setTimeout(
      () => req.destroy(new Error(NO_RESPONSE)),
      Math.max(0, deadline - Date.now())
    )
    req.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end()
  })
}

function parseContentDispositionFilename(disposition: string): string | null {
  // RFC 6266 / RFC 5987: filename* takes precedence over filename
  // format: filename*=charset'language'encoded-value
  const extMatch = /\bfilename\*=([a-zA-Z0-9_-]+)'[^']*'([^;\s]+)/i.exec(disposition)
  if (extMatch?.[2]) {
    // RFC 5987 requires both UTF-8 and ISO-8859-1. decodeURIComponent only reads UTF-8, so a
    // Latin-1 byte like %A3 (£) would throw and leave the raw escapes as the name.
    if (/^iso-8859-1$/i.test(extMatch[1])) {
      return extMatch[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      )
    }
    try {
      return decodeURIComponent(extMatch[2])
    } catch {
      return extMatch[2]
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
  const deadline = Date.now() + PROBE_TIMEOUT_MS

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await requestOneByte(current, deadline)
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

/** A link the server says is a torrent, or that is named like one. */
function isTorrentLink(headers: Headers, url: URL): boolean {
  const contentType = headerValue(headers, 'content-type') ?? ''
  return /^application\/x-bittorrent\b/i.test(contentType) || /\.torrent$/i.test(url.pathname)
}

/** What a link would download: a file over HTTP(S), or a torrent — a magnet link, a link to a
 * .torrent, or the path of a .torrent on this computer (opened or dropped on the window). */
export async function probeUrl(rawUrl: string): Promise<ProbeResult> {
  if (/^magnet:/i.test(rawUrl)) return describeTorrent(await fetchMagnetMetadata(rawUrl), rawUrl)
  if (isAbsolute(rawUrl) && /\.torrent$/i.test(rawUrl)) {
    return describeTorrent(await readTorrentFile(rawUrl), rawUrl)
  }

  const { current, response } = await requestFollowingRedirects(rawUrl)

  // An empty file can't satisfy a request for its first byte: the server answers 416 and gives
  // the size as `bytes */0`. That's a valid, empty download, not an error.
  if (
    response?.statusCode === 416 &&
    /^\s*bytes\s+\*\/0\s*$/i.test(headerValue(response.headers, 'content-range') ?? '')
  ) {
    return {
      kind: 'http',
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

  if (isTorrentLink(response.headers, current)) {
    const finalUrl = current.toString()
    return describeTorrent(await downloadTorrentFile(finalUrl, PROBE_TIMEOUT_MS), finalUrl)
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
    kind: 'http',
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
