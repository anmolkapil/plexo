import type { Writable } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import { asConnectionError, type StreamConnection } from '../network/routes'
import { testKnobs } from '../testKnobs'
import { compareVersion, type FileVersion, type VersionCheck } from './fileVersion'

export interface ChunkDownloadOptions {
  url: string
  rangeStart: number
  /** null = open-ended range, download to end of file. */
  rangeEnd: number | null
  /** The stream's connection, through the network it's bound to. */
  connection: StreamConnection
  createDestination: () => Writable
  /** Network bytes received, before destination backpressure or disk writes. */
  onNetworkProgress: (bytesReceivedThisRun: number) => void
  /** Bytes accepted by the destination writer; safe to include in resumable progress. */
  onProgress: (bytesDownloadedThisRun: number) => void
  signal: AbortSignal
  /** The version the download started on, plus any confirmed to serve identical bytes. */
  acceptedVersions: FileVersion[]
  /** Called once the server has answered with usable headers: how long that took, and whether
   * the request went out on a connection an earlier one had already warmed up. */
  onResponse?: (info: { ttfbMs: number; reusedSocket: boolean }) => void
  /** Optional custom headers forwarded to the server. */
  headers?: Record<string, string>
}

/** A response whose version doesn't match the download's. Nothing from it was written; the
 * caller decides whether it's a new file (fail) or the same bytes under another label (accept). */
export class RemoteChangedError extends Error {
  constructor(
    readonly check: Exclude<VersionCheck, { kind: 'same' }>,
    readonly seen: FileVersion
  ) {
    super(
      `The file on the server changed during the download (${check.detail}). Start the download over.`
    )
  }
}

/** The server answered with a status that isn't the range asked for. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    /** How long the server asked to be left alone (Retry-After), if it said. */
    readonly retryAfterMs: number | null
  ) {
    super(`Unexpected status ${status} for range request`)
  }

  /** A server that is busy, briefly broken or limiting requests: worth waiting out, not a sign
   * that asking again will never work. The statuses curl's --retry treats as transient. */
  get transient(): boolean {
    return [408, 429, 500, 502, 503, 504].includes(this.status)
  }
}

/** Retry-After (RFC 9110 §10.2.3), in seconds or as an HTTP date, as milliseconds from now. */
export function retryAfterMs(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

// A server that accepts the connection and then goes silent (no data, no
// error, no close) would otherwise hang the chunk forever with no way to
// detect or retry it.
const STALL_TIMEOUT_MS = testKnobs.stallTimeoutMs

// Only the initial probe resolves redirects today — if a CDN reissues a
// redirect mid-download (e.g. a signed URL rotates), a chunk needs to be
// able to follow it too instead of failing outright.
const MAX_REDIRECTS = 5

interface ServedRange {
  start: number
  end: number
  /** null when the server sent `*`. */
  total: number | null
}

/** Parses `Content-Range: bytes <start>-<end>/<total>`. Returns null if it isn't in that form. */
function parseContentRange(value: string | string[] | undefined): ServedRange | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(raw)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return { start, end, total: match[3] === '*' ? null : Number(match[3]) }
}

function header(res: IncomingMessage, name: string): string | undefined {
  const value = res.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The version a response says it's from. A 206 states the file's total size in
 * Content-Range; a 200 is the whole file, so its length is the size. */
function versionOf(res: IncomingMessage, served: ServedRange | null): FileVersion {
  const length = header(res, 'content-length')
  return {
    etag: header(res, 'etag') ?? null,
    lastModified: header(res, 'last-modified') ?? null,
    totalBytes: served?.total ?? (res.statusCode === 200 && length ? Number(length) : 0)
  }
}

/**
 * Downloads a single byte range of a URL, bound to one network interface, into a supplied writer.
 *
 * Resolving means the *entire* requested range was written, and nothing else was:
 * a chunk's bytes land at a fixed offset in the staged file, so a response
 * that is short, starts somewhere else, or overruns the range would corrupt the
 * output rather than just this chunk. Every one of those is a rejection, which
 * puts the block back on the queue for a retry instead of marking it done.
 */
export function downloadChunk(options: ChunkDownloadOptions): Promise<void> {
  const {
    url,
    rangeStart,
    rangeEnd,
    connection,
    createDestination,
    onNetworkProgress,
    onProgress,
    signal,
    acceptedVersions,
    onResponse
  } = options

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const expectedBytes = rangeEnd === null ? null : rangeEnd - rangeStart + 1

    let bytesDownloaded = 0
    let settled = false
    let currentReq: ClientRequest | null = null
    let currentFileStream: Writable | null = null
    let stallWatchdog: NodeJS.Timeout | null = null

    const clearWatchdog = (): void => {
      if (stallWatchdog) {
        clearTimeout(stallWatchdog)
        stallWatchdog = null
      }
    }

    const resetWatchdog = (): void => {
      clearWatchdog()
      stallWatchdog = setTimeout(() => {
        fail(asConnectionError(new Error('Connection stalled: no response from server')))
      }, STALL_TIMEOUT_MS)
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearWatchdog()
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    const fail = (error: Error): void =>
      finish(() => {
        currentReq?.destroy()
        // Closing the writer matters twice over: an abandoned stream holds
        // its descriptor for the life of the process (a paused-and-resumed
        // download, or a chunk that retries a few times, leaks one per
        // attempt until the process hits its open-file limit), and its
        // buffered writes would otherwise land after a retry has started.
        const stream = currentFileStream
        if (stream && !stream.closed) {
          stream.once('close', () => reject(error))
          stream.destroy()
        } else {
          reject(error)
        }
      })

    const onAbort = (): void => fail(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort)

    // The whole file from the start needs no Range at all — and an empty file would answer
    // `bytes=0-` with 416, since it has no byte 0 to start from.
    const headers: Record<string, string> = {
      'User-Agent': 'Plexo/1.0',
      ...(options.headers ?? {})
    }
    if (rangeStart > 0 || rangeEnd !== null) {
      headers['Range'] =
        rangeEnd === null ? `bytes=${rangeStart}-` : `bytes=${rangeStart}-${rangeEnd}`
    }

    const attempt = (targetUrl: URL, redirectsLeft: number): void => {
      void connection
        .request(targetUrl, headers, signal)
        .then(({ req, res, sentAt }) => {
          if (settled) {
            req.destroy()
            return
          }
          currentReq = req
          // The connection dropping mid-answer; one the server answered wrongly fails below.
          const dropped = (error: Error): void => fail(asConnectionError(error))
          req.on('error', dropped)
          const status = res.statusCode ?? 0

          if (status >= 300 && status < 400) {
            res.resume()
            if (!res.headers.location || redirectsLeft <= 0) {
              fail(new Error('Too many redirects for range request'))
              return
            }
            attempt(new URL(res.headers.location, targetUrl), redirectsLeft - 1)
            return
          }

          // A 200 is only correct here if we asked from byte 0 — otherwise the
          // server ignored our Range and we'd silently write the wrong bytes
          // into this chunk's slot. When the range is also bounded, the
          // length check at the end of the body is what confirms the server
          // sent this chunk rather than the whole file.
          const isValidFullBody = status === 200 && rangeStart === 0
          if (status !== 206 && !isValidFullBody) {
            fail(new HttpStatusError(status, retryAfterMs(header(res, 'retry-after'))))
            res.resume()
            return
          }

          // Each range is fetched separately, so a file republished mid-download would otherwise
          // be stitched together from two versions and still pass every length check.
          const served = parseContentRange(res.headers['content-range'])
          const seen = versionOf(res, served)
          const check = compareVersion(acceptedVersions, seen)
          if (check.kind !== 'same') {
            fail(new RemoteChangedError(check, seen))
            res.resume()
            return
          }

          // A 206 says where in the file these bytes belong — check it lines up
          // with what we asked for before writing any of them.
          if (status === 206) {
            if (!served) {
              fail(new Error('Server sent a 206 without a usable Content-Range header'))
              res.resume()
              return
            }
            if (served.start !== rangeStart) {
              fail(
                new Error(
                  `Server returned the wrong range: asked for byte ${rangeStart}, got ${served.start}`
                )
              )
              res.resume()
              return
            }
            if (rangeEnd !== null && served.end > rangeEnd) {
              fail(
                new Error(
                  `Server returned more than the requested range: through byte ${served.end}, asked through ${rangeEnd}`
                )
              )
              res.resume()
              return
            }
          }

          onResponse?.({ ttfbMs: Date.now() - sentAt, reusedSocket: req.reusedSocket })

          const fileStream = createDestination()
          currentFileStream = fileStream

          res.on('error', dropped)
          fileStream.on('error', fail)

          // Arm watchdog for incoming body bytes — drops and retries if the server sends
          // headers then freezes, or goes silent mid-stream.
          resetWatchdog()

          // Written by hand rather than piped so an overlong body can be cut off
          // at the range boundary: an overlong response could overwrite the next block.
          res.on('data', (chunk: Buffer) => {
            if (settled) return
            resetWatchdog()

            const remaining =
              expectedBytes === null ? chunk.length : expectedBytes - bytesDownloaded
            const usable =
              chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(remaining, 0))

            if (usable.length > 0) {
              bytesDownloaded += usable.length
              const progress = bytesDownloaded
              onNetworkProgress(progress)
              if (
                !fileStream.write(usable, (error) => {
                  if (error) fail(error)
                  else if (!settled) onProgress(progress)
                })
              ) {
                // Waiting on the disk says nothing about the network: the watchdog stops until
                // the writer has caught up.
                clearWatchdog()
                res.pause()
                fileStream.once('drain', () => {
                  resetWatchdog()
                  res.resume()
                })
              }
            }

            if (usable.length < chunk.length) {
              fail(new Error('Server sent more data than the requested range'))
            }
          })

          res.on('end', () => {
            if (settled) return
            clearWatchdog()
            if (expectedBytes !== null && bytesDownloaded !== expectedBytes) {
              fail(
                new Error(
                  `Server returned ${bytesDownloaded} bytes for a ${expectedBytes}-byte range`
                )
              )
              return
            }
            // Windows cannot reliably reopen/remove a file until its handle closes.
            fileStream.once('close', () => finish(resolve))
            fileStream.end()
          })
        })
        .catch(fail)
    }

    attempt(new URL(url), MAX_REDIRECTS)
  })
}

/** Fetches `start`..`end` into memory, following redirects, and reports which version served
 * it — used to compare a few bytes already on disk against what a server serves now. */
export function fetchRange(
  url: string,
  start: number,
  end: number,
  connection: StreamConnection,
  customHeaders?: Record<string, string>
): Promise<{ body: Buffer; version: FileVersion }> {
  return new Promise((resolve, reject) => {
    const attempt = (target: URL, redirectsLeft: number): void => {
      void connection
        .request(target, {
          'User-Agent': 'Plexo/1.0',
          ...(customHeaders ?? {}),
          Range: `bytes=${start}-${end}`
        })
        .then(({ req, res }) => {
          req.on('error', reject)
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume()
            attempt(new URL(res.headers.location, target), redirectsLeft - 1)
            return
          }
          const served = parseContentRange(res.headers['content-range'])
          if (status !== 206 || served?.start !== start) {
            res.resume()
            reject(new Error(`Unexpected response to a sample request (status ${status})`))
            return
          }
          const chunks: Buffer[] = []
          res.setTimeout(STALL_TIMEOUT_MS, () => req.destroy(new Error('Sample request stalled')))
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () =>
            resolve({ body: Buffer.concat(chunks), version: versionOf(res, served) })
          )
        })
        .catch(reject)
    }
    attempt(new URL(url), MAX_REDIRECTS)
  })
}
