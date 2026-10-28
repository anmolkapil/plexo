import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, isAbsolute } from 'node:path'
import { URL } from 'node:url'
import type { BrowserContext, ProbeResult } from '../../shared/types'
import { testKnobs } from '../testKnobs'
import { requestHeaders } from './browserContext'
import { parseContentDispositionFilename } from './contentDisposition'
import { describeNzb, downloadNzbFile, indexerError, readNzbFile, sniffXml } from './nzb/nzbFile'
import { normalizeEtag } from './fileVersion'
import {
  describeTorrent,
  downloadTorrentFile,
  fetchMagnetMetadata,
  readTorrentFile
} from './torrent/metadata'

const MAX_REDIRECTS = 5
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

/** GET with a small range: cheaper than fetching the body, and unlike HEAD it also tells us (via
 * the 206 status) whether range requests actually work. Not 1 byte: some file hosts answer a range
 * that ends at byte 0 or 1 with the whole file, while serving every real chunk as asked (#101).
 * `ranged: false` sends a plain GET instead; the body is still dropped once the headers arrive. */
function requestFirstBytes(
  url: URL,
  deadline: number,
  browser: BrowserContext | undefined,
  ranged: boolean,
  range = 'bytes=0-1023'
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(
      {
        method: 'GET',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: ranged
          ? { ...requestHeaders(url, browser), Range: range }
          : requestHeaders(url, browser)
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
  rawUrl: string,
  browser: BrowserContext | undefined
): Promise<{ current: URL; response: ProbeResponse | null }> {
  let current = new URL(rawUrl)
  let response: ProbeResponse | null = null
  const deadline = Date.now() + PROBE_TIMEOUT_MS

  let ranged = true
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await requestFirstBytes(current, deadline, browser, ranged)
    // Some servers refuse any Range request with 403 while serving the same URL in full (#131).
    // Ask once more without one: if that works, the file downloads as one stream from byte zero,
    // which sends no Range either — the same as on a server without range support.
    if (response.statusCode === 403 && ranged) {
      ranged = false
      response = await requestFirstBytes(current, deadline, browser, ranged)
    }
    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = headerValue(response.headers, 'location')
      if (!location) break
      if (redirect === MAX_REDIRECTS) {
        throw new Error('Too many redirects while checking the link')
      }
      current = new URL(location, current)
      continue
    }
    break
  }

  return { current, response }
}

/** Whether the server labels each byte range with an ETag of its own (pCloud does, #156): then
 * no chunk's ETag ever matches the probe's, and every one would be taken for a changed file.
 * The first range asked again keeps its ETag while the next range gets another. A load balancer
 * alternating labels per request changes it on the repeat instead, and keeps its ETag checked. */
async function etagIsPerRange(
  url: URL,
  browser: BrowserContext | undefined,
  first: ProbeResponse
): Promise<boolean> {
  const etag = headerValue(first.headers, 'etag')
  const total = /\/(\d+)$/.exec(headerValue(first.headers, 'content-range') ?? '')?.[1]
  if (first.statusCode !== 206 || !etag || !total || Number(total) <= 2048) return false
  const deadline = Date.now() + PROBE_TIMEOUT_MS
  try {
    const again = await requestFirstBytes(url, deadline, browser, true)
    const next = await requestFirstBytes(url, deadline, browser, true, 'bytes=1024-2047')
    const etagOf = (r: ProbeResponse): string => normalizeEtag(headerValue(r.headers, 'etag') ?? '')
    return (
      again.statusCode === 206 &&
      next.statusCode === 206 &&
      etagOf(again) === normalizeEtag(etag) &&
      etagOf(next) !== '' &&
      etagOf(next) !== normalizeEtag(etag)
    )
  } catch {
    return false
  }
}

/** A link the server says is a torrent, or that is named like one. */
function isTorrentLink(headers: Headers, url: URL): boolean {
  const contentType = headerValue(headers, 'content-type') ?? ''
  return /^application\/x-bittorrent\b/i.test(contentType) || /\.torrent$/i.test(url.pathname)
}

/** A link the server says is an NZB, or that is named like one. Indexers serve them from API
 * links that say nothing in their path, so the type is what usually tells. */
function isNzbLink(headers: Headers, url: URL, fileName: string): boolean {
  const contentType = headerValue(headers, 'content-type') ?? ''
  return (
    /^application\/x-nzb\b/i.test(contentType) ||
    /\.nzb$/i.test(url.pathname) ||
    /\.nzb$/i.test(fileName)
  )
}

/** What a link would download: a file over HTTP(S), a torrent — a magnet link, a link to a
 * .torrent, or the path of a .torrent on this computer (opened or dropped on the window) — or an
 * NZB, by link or path, the same way. `browser`: what the browser it came from sends with it (see
 * BrowserContext). */
export async function probeUrl(rawUrl: string, browser?: BrowserContext): Promise<ProbeResult> {
  if (/^magnet:/i.test(rawUrl)) return describeTorrent(await fetchMagnetMetadata(rawUrl), rawUrl)
  if (isAbsolute(rawUrl) && /\.torrent$/i.test(rawUrl)) {
    return describeTorrent(await readTorrentFile(rawUrl), rawUrl)
  }
  if (isAbsolute(rawUrl) && /\.nzb$/i.test(rawUrl)) {
    return describeNzb(await readNzbFile(rawUrl), rawUrl, basename(rawUrl))
  }

  const { current, response } = await requestFollowingRedirects(rawUrl, browser)

  // An empty file can't satisfy a request for its first bytes: the server answers 416 and gives
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
    const torrentFile = await downloadTorrentFile(
      finalUrl,
      PROBE_TIMEOUT_MS,
      requestHeaders(current, browser)
    )
    return describeTorrent(torrentFile, finalUrl)
  }

  const suggestedFileName = fileNameFromHeaders(response.headers, current)
  if (isNzbLink(response.headers, current, suggestedFileName)) {
    const finalUrl = current.toString()
    const nzbFile = await downloadNzbFile(
      finalUrl,
      PROBE_TIMEOUT_MS,
      requestHeaders(current, browser)
    )
    return describeNzb(nzbFile, finalUrl, suggestedFileName)
  }
  // An indexer's API answers in XML either way: an NZB it doesn't label as one, or an error (a
  // wrong API key, its daily limit reached) where the NZB would be. Its start tells which.
  if (/xml/i.test(headerValue(response.headers, 'content-type') ?? '')) {
    const finalUrl = current.toString()
    const headers = requestHeaders(current, browser)
    const start = await sniffXml(finalUrl, PROBE_TIMEOUT_MS, headers)
    const refusal = indexerError(start)
    if (refusal) throw new Error(refusal)
    if (/<(?:[\w-]+:)?nzb\b/i.test(start)) {
      const nzbFile = await downloadNzbFile(finalUrl, PROBE_TIMEOUT_MS, headers)
      return describeNzb(nzbFile, finalUrl, suggestedFileName)
    }
  }

  const contentRange = headerValue(response.headers, 'content-range')
  // A server that supports range requests must answer our range GET with 206 Partial Content.
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
    // describes the bytes we asked for, not the whole file.
    const contentLength = headerValue(response.headers, 'content-length')
    if (contentLength) totalBytes = Number(contentLength)
  }

  const perRange = await etagIsPerRange(current, browser, response)

  return {
    kind: 'http',
    requestedUrl: rawUrl,
    finalUrl: current.toString(),
    supportsRanges,
    totalBytes,
    suggestedFileName,
    contentType: headerValue(response.headers, 'content-type') ?? null,
    etag: perRange ? null : (headerValue(response.headers, 'etag') ?? null),
    lastModified: headerValue(response.headers, 'last-modified') ?? null
  }
}
