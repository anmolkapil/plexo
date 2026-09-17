import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import type { ProbeResult } from '../../shared/types'

const MAX_REDIRECTS = 5
const USER_AGENT = 'Plexo/1.0'

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
    req.end()
  })
}

function fileNameFromHeaders(headers: Headers, url: URL): string {
  const disposition = headerValue(headers, 'content-disposition')
  if (disposition) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1])
      } catch {
        return match[1]
      }
    }
  }
  const pathname = decodeURIComponent(url.pathname)
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

/**
 * Re-checks a previously probed URL's strong validators before a paused
 * download resumes. Appending onto part files assumes the remote content
 * hasn't changed since it was probed — if it has (a different ETag or
 * Last-Modified), stitching old and new bytes together would silently
 * produce a corrupt file. Returns true when unchanged *or* when we can't
 * tell (no validators, or the check itself failed) — a probe failure isn't
 * proof the file changed, so it shouldn't block a resume on its own.
 */
export async function isResourceUnchanged(
  rawUrl: string,
  etag: string | null,
  lastModified: string | null
): Promise<boolean> {
  if (!etag && !lastModified) return true

  try {
    const { response } = await requestFollowingRedirects(rawUrl)
    if (!response || response.statusCode >= 400) return true

    const currentEtag = headerValue(response.headers, 'etag')
    const currentLastModified = headerValue(response.headers, 'last-modified')
    if (etag && currentEtag) return currentEtag === etag
    if (lastModified && currentLastModified) return currentLastModified === lastModified
    return true
  } catch {
    return true
  }
}

export async function probeUrl(rawUrl: string): Promise<ProbeResult> {
  const { current, response } = await requestFollowingRedirects(rawUrl)

  if (!response || response.statusCode === 0 || response.statusCode >= 400) {
    throw new Error(`Server responded with status ${response?.statusCode || 'unknown'}`)
  }

  const contentRange = headerValue(response.headers, 'content-range')
  const acceptRanges = headerValue(response.headers, 'accept-ranges')
  const supportsRanges =
    response.statusCode === 206 || (acceptRanges != null && acceptRanges !== 'none')

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
