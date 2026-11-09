import { connect as netConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { asConnectionError } from '../../network/routes'
import { testKnobs } from '../../testKnobs'
import type { UsenetServerConfig } from './usenetServer'

/** The server answered a command with something other than what it should have. */
export class NntpError extends Error {
  constructor(
    readonly code: number,
    text: string
  ) {
    super(text ? `The news server answered ${code}: ${text}` : `The news server answered ${code}`)
  }
}

/** The server doesn't have the article (430): expired, taken down, or never fully posted. */
export class ArticleMissingError extends NntpError {}

/** The server didn't accept the username or password, or wants them and has none. */
export class NntpAuthError extends NntpError {}

/** The server turned the connection away: more connections than the account allows, or none
 * for now. One connection fewer is what helps, not trying again at once. */
export class NntpRefusedError extends NntpError {}

const CRLF = Buffer.from('\r\n')
/** A multi-line answer ends with a line holding a single dot. */
const TERMINATOR = Buffer.from('\r\n.\r\n')
/** A status line longer than this isn't one: the connection isn't speaking NNTP. */
const MAX_LINE_BYTES = 4096

interface Reading {
  /** Handed whatever is buffered, whenever more arrives: how much of it the read took, and
   * whether that finished it. */
  take: (buffered: Buffer) => { consumed: number; done: boolean }
  resolve: () => void
  reject: (error: Error) => void
}

/**
 * One connection to a news server, speaking just what downloading articles needs: the greeting,
 * AUTHINFO, and BODY by message ID (RFC 3977, RFC 4643). One command at a time. The socket comes
 * connected (through one network, TLS already on when the server wants it); this only reads and
 * writes it.
 *
 * Every read is watched: a server that goes silent for `timeoutMs` mid-answer has its connection
 * dropped, as a stalled HTTP response is.
 */
export class NntpConnection {
  private buffered: Buffer = Buffer.alloc(0)
  private reading: Reading | null = null
  private closed: Error | null = null
  private stallTimer: NodeJS.Timeout | undefined

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error) => this.fail(asConnectionError(error)))
    socket.on('close', () =>
      this.fail(asConnectionError(new Error('The news server closed the connection')))
    )
  }

  /** Greets the server and signs in. Throws NntpRefusedError when it turns the connection away,
   * NntpAuthError when it doesn't take the sign-in. */
  static async open(
    socket: Socket,
    options: { timeoutMs: number; username: string; password: string; signal: AbortSignal }
  ): Promise<NntpConnection> {
    const connection = new NntpConnection(socket, options.timeoutMs)
    const onAbort = (): void => connection.destroy()
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const greeting = await connection.status()
      if (greeting.code === 400 || greeting.code === 502) {
        throw new NntpRefusedError(greeting.code, greeting.text)
      }
      if (greeting.code !== 200 && greeting.code !== 201) {
        throw new NntpError(greeting.code, greeting.text)
      }
      if (options.username) await connection.authenticate(options.username, options.password)
      return connection
    } catch (error) {
      connection.destroy()
      throw options.signal.aborted ? abortError() : error
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }
  }

  private async authenticate(username: string, password: string): Promise<void> {
    let reply = await this.command(`AUTHINFO USER ${username}`)
    if (reply.code === 381) reply = await this.command(`AUTHINFO PASS ${password}`)
    if (reply.code === 281) return
    throw signInError(reply.code, reply.text)
  }

  /**
   * An article's body by message ID, dot-unstuffed: lines joined by CRLF, as posted. `onData` is
   * told each chunk's size as it arrives (for the speed meters and limits) and answers how long
   * to wait before reading more. Throws ArticleMissingError when the server doesn't have it.
   */
  async body(
    messageId: string,
    onData: (bytes: number) => number,
    signal: AbortSignal
  ): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const onAbort = (): void => this.destroy()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const reply = await this.command(`BODY <${messageId}>`)
      if (reply.code === 430 || reply.code === 423) {
        throw new ArticleMissingError(reply.code, reply.text)
      }
      if (reply.code === 480 || reply.code === 481) throw signInError(reply.code, reply.text)
      if (reply.code === 400 || reply.code === 502) {
        throw new NntpRefusedError(reply.code, reply.text)
      }
      if (reply.code !== 222) throw new NntpError(reply.code, reply.text)
      return unstuff(await this.block(onData))
    } catch (error) {
      throw signal.aborted ? abortError() : error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Says goodbye, as servers like, and closes. */
  close(): void {
    if (!this.closed && this.socket.writable) this.socket.end('QUIT\r\n')
    this.destroy()
  }

  destroy(): void {
    this.fail(asConnectionError(new Error('The connection was closed')))
    this.socket.destroy()
  }

  private async command(line: string): Promise<{ code: number; text: string }> {
    if (this.closed) throw this.closed
    this.socket.write(`${line}\r\n`)
    return this.status()
  }

  /** The next status line: a three-digit code and its text. */
  private status(): Promise<{ code: number; text: string }> {
    let line = ''
    return this.read((buffered) => {
      const end = buffered.indexOf(CRLF)
      if (end < 0) {
        if (buffered.length > MAX_LINE_BYTES) throw new Error('The server isn’t a news server')
        return { consumed: 0, done: false }
      }
      line = buffered.subarray(0, end).toString('latin1')
      return { consumed: end + CRLF.length, done: true }
    }).then(() => {
      const match = /^(\d{3})(?:\s(.*))?$/.exec(line)
      if (!match) throw asConnectionError(new Error('The server isn’t a news server'))
      return { code: Number(match[1]), text: (match[2] ?? '').trim() }
    })
  }

  /** A multi-line answer, up to its terminating dot, as it came: still dot-stuffed. */
  private block(onData: (bytes: number) => number): Promise<Buffer> {
    const chunks: Buffer[] = []
    // A body that is empty ends at once with ".\r\n": as if the status line's CRLF came before it.
    let tail = CRLF
    let result = Buffer.alloc(0)
    return this.read((buffered) => {
      const window = Buffer.concat([tail, buffered])
      const found = window.indexOf(TERMINATOR)
      if (found < 0) {
        chunks.push(buffered)
        tail = window.subarray(Math.max(0, window.length - (TERMINATOR.length - 1)))
        this.throttle(onData(buffered.length))
        return { consumed: buffered.length, done: false }
      }
      // Where the terminator ends, in `buffered`; the body is everything before its ".\r\n".
      const consumed = found + TERMINATOR.length - tail.length
      const bodyEnd = consumed - 3
      if (bodyEnd > 0) chunks.push(buffered.subarray(0, bodyEnd))
      let body = Buffer.concat(chunks)
      // The CRLF ending the last line is the terminator's, but it's part of the body too.
      if (bodyEnd < 0) body = body.subarray(0, body.length + bodyEnd)
      result = body
      this.throttle(onData(consumed))
      return { consumed, done: true }
    }).then(() => result)
  }

  private throttle(wait: number): void {
    if (wait <= 0) return
    this.socket.pause()
    setTimeout(() => this.socket.resume(), wait)
  }

  private read(take: Reading['take']): Promise<void> {
    if (this.closed) return Promise.reject(this.closed)
    return new Promise<void>((resolve, reject) => {
      this.reading = { take, resolve, reject }
      this.armStall()
      this.drain()
    })
  }

  private onData(chunk: Buffer): void {
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk
    if (this.reading) this.armStall()
    this.drain()
  }

  /** Hands what is buffered to the read waiting for it, if any. */
  private drain(): void {
    const reading = this.reading
    if (!reading || this.buffered.length === 0) return
    let taken: { consumed: number; done: boolean }
    try {
      taken = reading.take(this.buffered)
    } catch (error) {
      this.fail(error as Error)
      return
    }
    this.buffered = this.buffered.subarray(taken.consumed)
    if (!taken.done) return
    this.reading = null
    clearTimeout(this.stallTimer)
    reading.resolve()
  }

  private armStall(): void {
    clearTimeout(this.stallTimer)
    this.stallTimer = setTimeout(
      () =>
        this.fail(
          asConnectionError(new Error('Connection stalled: the news server stopped answering'))
        ),
      this.timeoutMs
    )
  }

  private fail(error: Error): void {
    clearTimeout(this.stallTimer)
    this.closed ??= error
    const reading = this.reading
    this.reading = null
    reading?.reject(error)
    if (!this.socket.destroyed) this.socket.destroy()
  }
}

function signInError(code: number, text: string): NntpError {
  // Some servers answer a sign-in over the account's connection limit with 481 or 502 too; their
  // text says so.
  if (/connection/i.test(text) && !/password|user|auth/i.test(text)) {
    return new NntpRefusedError(code, text)
  }
  return new NntpAuthError(code, text)
}

/** Lines that start with a dot are sent with another one before it (RFC 3977 §3.1.1). */
function unstuff(body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(body.length)
  let length = 0
  let lineStart = true
  for (let i = 0; i < body.length; i++) {
    const byte = body[i]
    if (lineStart && byte === 0x2e && body[i + 1] === 0x2e) {
      lineStart = false
      continue
    }
    out[length++] = byte
    lineStart = byte === 0x0a
  }
  return out.subarray(0, length)
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError')

/** Connects to `server` over the computer's default route and signs in, then says goodbye: what
 * the server settings check before they're used. Throws what went wrong, in words. */
export async function testUsenetServer(server: UsenetServerConfig): Promise<void> {
  const signal = AbortSignal.timeout(testKnobs.connectTimeoutMs)
  const socket = await new Promise<Socket>((resolve, reject) => {
    const { host, port } = server
    const socket = server.tls
      ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host })
      : netConnect({ host, port })
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once(server.tls ? 'secureConnect' : 'connect', () => {
      signal.removeEventListener('abort', onAbort)
      socket.off('error', fail)
      resolve(socket)
    })
    socket.once('error', fail)
    const onAbort = (): void => fail(new Error(`${host} didn’t answer on port ${port}`))
    signal.addEventListener('abort', onAbort, { once: true })
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      throw new Error(`Couldn’t find ${server.host}. Check the address.`)
    }
    if (error.code === 'ECONNREFUSED') {
      throw new Error(`${server.host} isn’t accepting connections on port ${server.port}.`)
    }
    throw error
  })
  try {
    const connection = await NntpConnection.open(socket, {
      timeoutMs: testKnobs.connectTimeoutMs,
      username: server.username,
      password: server.password,
      signal
    })
    connection.close()
  } catch (error) {
    if (error instanceof NntpAuthError) {
      throw new Error('The server didn’t accept the username or password.')
    }
    if (error instanceof NntpRefusedError) {
      throw new Error(
        `The server turned the connection away, often because every connection the account allows is in use. (${error.message})`
      )
    }
    throw error
  }
}
