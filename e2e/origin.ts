import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/**
 * The download server every e2e test talks to. It serves one file and can be told, per
 * request, to misbehave in exactly the ways a real server or network does — and to *hold* a
 * response at a byte offset, so a test can pause, kill or race the app at a precise point in
 * the transfer instead of guessing with timeouts.
 */

/** What the server does with one request. Anything other than 'ok' is a fault. */
export type Fault =
  | 'ok'
  /** Replies 200 with the whole file, as a server without range support does. */
  | 'ignoreRange'
  /** 206 whose Content-Range starts one byte later than asked. */
  | 'wrongStart'
  /** 206 with a correct header but one byte more body than the range. */
  | 'overlong'
  /** 206 with no Content-Range header. */
  | 'noContentRange'
  /** Sends headers, then nothing, forever. */
  | 'stallBody'
  /** Never answers at all. */
  | 'stallHeaders'
  | { status: number }
  /** Sends this many body bytes, then drops the connection. */
  | { cutAfter: number }
  /** Sends this many body bytes, then ends the response cleanly (a short body). */
  | { endAfter: number }
  /** Trickles the body at this rate in small pieces — slow, but never silent long enough to stall. */
  | { crawl: number }
  | { redirect: string }

export interface OriginRequest {
  /** 1-based count of requests this server has seen. */
  n: number
  path: string
  /** Source address — which "network" the request came in on. */
  from: string
  range: { start: number; end: number | null } | null
}

export interface LoggedRequest extends OriginRequest {
  fault: Fault
  status: number
  bytesSent: number
}

export interface OriginOptions {
  size: number
  seed?: number
  /** false: ignore Range headers and never advertise Accept-Ranges. */
  ranges?: boolean
  /** false: omit Content-Length (chunked transfer), so the size is unknown. */
  contentLength?: boolean
  etag?: string | null
  lastModified?: string | null
  contentDisposition?: string
  /** Per-response speed limit, so a download lasts long enough to be interrupted. */
  bytesPerSecond?: number
}

/** Deterministic bytes, so a failing seed reproduces the exact same file. */
export function seededBytes(size: number, seed: number): Buffer {
  const buffer = Buffer.alloc(size)
  let state = seed >>> 0 || 1
  for (let i = 0; i < size; i++) {
    // xorshift32
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    buffer[i] = state & 0xff
  }
  return buffer
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

const PIECE_BYTES = 16 * 1024

function parseRange(header: string | undefined): OriginRequest['range'] {
  const match = header && /^bytes=(\d+)-(\d*)$/.exec(header)
  if (!match) return null
  return { start: Number(match[1]), end: match[2] === '' ? null : Number(match[2]) }
}

export class Origin {
  content: Buffer
  etag: string | null
  lastModified: string | null
  readonly log: LoggedRequest[] = []
  private rule: (request: OriginRequest) => Fault | undefined = () => 'ok'
  private version: (
    request: OriginRequest
  ) => { content: Buffer; etag: string | null } | undefined = () => undefined
  private holdAt: number | null = null
  private holdReached: (() => void) | null = null
  private holdRelease: (() => void) | null = null
  private releasePromise: Promise<void> = Promise.resolve()
  private reachedPromise: Promise<void> = Promise.resolve()
  private sockets = new Set<Socket>()
  private server = createServer((req, res) => void this.handle(req, res))
  private port = 0

  constructor(private options: OriginOptions) {
    this.content = seededBytes(options.size, options.seed ?? 1)
    this.etag = options.etag === undefined ? '"v1"' : options.etag
    this.lastModified = options.lastModified ?? null
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
  }

  async start(): Promise<this> {
    // 0.0.0.0 so requests bound to a LAN address (the second test "network") still arrive.
    await new Promise<void>((resolve) => this.server.listen(0, '0.0.0.0', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    this.release()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  url(path = '/files/test.bin'): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  get sha256(): string {
    return sha256(this.content)
  }

  /** Decides each request's fault. Returning undefined means 'ok'. */
  setRule(rule: (request: OriginRequest) => Fault | undefined): void {
    this.rule = rule
  }

  /** Answers some requests as if from another server behind a load balancer, with its own
   * content and ETag. Returning undefined serves the default version. */
  setVersionRule(
    rule: (request: OriginRequest) => { content: Buffer; etag: string | null } | undefined
  ): void {
    this.version = rule
  }

  /** Swaps the served file, as a server publishing a new version would. */
  setContent(content: Buffer, etag: string | null): void {
    this.content = content
    this.etag = etag
  }

  /**
   * Stops every response just before it sends the byte at `offset`, until release(). Resolves
   * once the first response reaches it — i.e. the app has received exactly the bytes before it.
   */
  hold(offset: number): Promise<void> {
    this.release()
    this.holdAt = offset
    this.reachedPromise = new Promise((resolve) => (this.holdReached = resolve))
    this.releasePromise = new Promise((resolve) => (this.holdRelease = resolve))
    return this.reachedPromise
  }

  release(): void {
    this.holdAt = null
    this.holdRelease?.()
    this.holdRelease = null
  }

  /** Requests that asked for byte ranges, i.e. the app's chunk requests (not the 1-byte probe). */
  chunkRequests(): LoggedRequest[] {
    return this.log.filter((entry) => !(entry.range?.start === 0 && entry.range.end === 0))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request: OriginRequest = {
      n: this.log.length + 1,
      path: req.url ?? '/',
      from: (req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''),
      range: parseRange(req.headers.range)
    }
    const fault = this.rule(request) ?? 'ok'
    const entry: LoggedRequest = { ...request, fault, status: 0, bytesSent: 0 }
    this.log.push(entry)

    if (fault === 'stallHeaders') return
    if (typeof fault === 'object' && 'status' in fault) {
      entry.status = fault.status
      res.writeHead(fault.status).end()
      return
    }
    if (typeof fault === 'object' && 'redirect' in fault) {
      entry.status = 302
      res.writeHead(302, { Location: fault.redirect }).end()
      return
    }

    // The app's 1-byte probes (bytes=0-0) are never held — only real transfers are.
    const holdable = !(request.range?.start === 0 && request.range.end === 0)
    if (holdable && this.holdAt !== null && request.range && request.range.start > this.holdAt) {
      await this.releasePromise
    }

    // Snapshot, so a setContent() mid-response doesn't splice two versions into one reply.
    const served = this.version(request)
    const content = served?.content ?? this.content
    const etag = served ? served.etag : this.etag
    const total = content.length
    const headers: Record<string, string | number> = {}
    if (etag) headers['ETag'] = etag
    if (this.lastModified) headers['Last-Modified'] = this.lastModified
    if (this.options.contentDisposition) {
      headers['Content-Disposition'] = this.options.contentDisposition
    }

    const rangesOn = this.options.ranges !== false && fault !== 'ignoreRange'
    if (this.options.ranges !== false) headers['Accept-Ranges'] = 'bytes'

    let start = 0
    let end = total - 1
    let status = 200
    if (rangesOn && request.range) {
      start = request.range.start
      end = Math.min(request.range.end ?? total - 1, total - 1)
      if (start >= total) {
        entry.status = 416
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
        return
      }
      status = 206
      if (fault !== 'noContentRange') {
        const shownStart = fault === 'wrongStart' ? start + 1 : start
        headers['Content-Range'] = `bytes ${shownStart}-${end}/${total}`
      }
    }

    let bodyEnd = end + 1 // exclusive
    if (fault === 'overlong') bodyEnd = Math.min(bodyEnd + 1, total)
    if (typeof fault === 'object' && 'endAfter' in fault) {
      bodyEnd = Math.min(bodyEnd, start + fault.endAfter)
    }
    const cutAfter = typeof fault === 'object' && 'cutAfter' in fault ? fault.cutAfter : null
    const crawl = typeof fault === 'object' && 'crawl' in fault ? fault.crawl : null
    const rate = crawl ?? this.options.bytesPerSecond

    if (this.options.contentLength !== false && cutAfter === null) {
      headers['Content-Length'] = bodyEnd - start
    }
    entry.status = status
    res.writeHead(status, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    if (fault === 'stallBody') {
      res.flushHeaders()
      return
    }

    let position = start
    while (position < bodyEnd) {
      if (res.destroyed) return
      if (cutAfter !== null && position - start >= cutAfter) {
        req.socket.destroy()
        return
      }

      let next = Math.min(bodyEnd, position + (crawl ? 256 : PIECE_BYTES))
      if (cutAfter !== null) next = Math.min(next, start + cutAfter)
      if (holdable && this.holdAt !== null) {
        if (position === this.holdAt) {
          this.holdReached?.()
          await this.releasePromise
          continue
        }
        if (this.holdAt > position && this.holdAt < next) next = this.holdAt
      }

      const piece = content.subarray(position, next)
      entry.bytesSent += piece.length
      position = next
      if (!res.write(piece)) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
          }
          res.on('drain', done)
          res.on('close', done)
        })
      } else {
        // Yield so other connections — and the app's pause/cancel — interleave with this one.
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (rate) {
        await new Promise((resolve) => setTimeout(resolve, (piece.length / rate) * 1000))
      }
    }

    if (cutAfter !== null) {
      req.socket.destroy()
      return
    }
    res.end()
  }
}
