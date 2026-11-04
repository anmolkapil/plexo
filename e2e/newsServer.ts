import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { crc32 } from 'node:zlib'
import { treeSha } from './fixtures'

/**
 * A news server for the NZB tests: it posts files as yEnc articles, writes the NZB that lists
 * them, and serves them over NNTP (just what downloading takes: the greeting, AUTHINFO, BODY,
 * QUIT). Like the HTTP origin (origin.ts) it can be told to misbehave — an article it doesn't
 * have, one it sends damaged, a connection it drops partway or lets stall, more connections than
 * the account allows — so each test can say exactly what the app must cope with.
 */

export interface NewsFile {
  name: string
  data: Buffer
}

/** One article, as posted. */
interface Article {
  messageId: string
  file: number
  /** Its place in its file, from 1. */
  number: number
  begin: number
  data: Buffer
  /** As it goes over the wire: yEnc, lines ended by CRLF, not yet dot-stuffed. */
  body: Buffer
}

export interface NewsServerOptions {
  files: NewsFile[]
  /** Decoded bytes per article. */
  articleBytes?: number
  username?: string
  password?: string
  /** More connections at once than this are turned away with 502. */
  maxConnections?: number
  /** Articles the server doesn't have (430), by message ID. */
  missing?: (article: { file: number; number: number }) => boolean
  /** How the server answers this BODY, by its how-manyth request for the article (from 1). */
  fault?: (article: { file: number; number: number }, request: number) => ArticleFault
  /** Waits this long before answering each BODY: slow enough for a test to act partway. */
  delayMs?: number
}

/** - ok: the article as posted.
 * - corrupt: one byte of its data flipped, its checksum unchanged.
 * - cut: half of it, then the connection dropped.
 * - stall: half of it, then nothing. */
export type ArticleFault = 'ok' | 'corrupt' | 'cut' | 'stall'

export interface ServedArticle {
  messageId: string
  /** The client's address: which network it came in on. */
  from: string
  connection: number
  fault: ArticleFault | 'missing'
}

const LINE = 128

/** yEnc lines of `data`, each ended by CRLF: every byte plus 42, the critical ones escaped (no
 * RFC, but every poster does this). Written straight into one buffer: a test may post gigabytes. */
export function yencEncode(data: Buffer): Buffer {
  // At worst every byte escaped, plus a CRLF for every line.
  const out = Buffer.allocUnsafe(data.length * 2 + Math.ceil((data.length * 2) / LINE) * 2 + 2)
  let length = 0
  let column = 0
  for (let i = 0; i < data.length; i++) {
    const byte = (data[i] + 42) & 0xff
    const atEdge = column === 0 || column >= LINE - 1 || i === data.length - 1
    // NUL, LF, CR and '=' always; a leading or trailing space or tab, and a leading dot.
    if (
      byte === 0x00 ||
      byte === 0x0a ||
      byte === 0x0d ||
      byte === 0x3d ||
      (atEdge && (byte === 0x20 || byte === 0x09)) ||
      (column === 0 && byte === 0x2e)
    ) {
      out[length++] = 0x3d
      out[length++] = (byte + 64) & 0xff
      column += 2
    } else {
      out[length++] = byte
      column++
    }
    if (column >= LINE) {
      out[length++] = 0x0d
      out[length++] = 0x0a
      column = 0
    }
  }
  if (column > 0) {
    out[length++] = 0x0d
    out[length++] = 0x0a
  }
  return out.subarray(0, length)
}

function post(files: NewsFile[], articleBytes: number): Article[] {
  const articles: Article[] = []
  files.forEach((file, index) => {
    const total = Math.max(1, Math.ceil(file.data.length / articleBytes))
    for (let part = 1; part <= total; part++) {
      const begin = (part - 1) * articleBytes
      const data = file.data.subarray(begin, Math.min(begin + articleBytes, file.data.length))
      const header = [
        `=ybegin part=${part} total=${total} line=${LINE} size=${file.data.length} name=${file.name}`,
        `=ypart begin=${begin + 1} end=${begin + data.length}`
      ]
      const trailer = `=yend size=${data.length} part=${part} pcrc32=${(crc32(data) >>> 0).toString(16).padStart(8, '0')}`
      const body = Buffer.concat([
        Buffer.from(`${header.join('\r\n')}\r\n`),
        yencEncode(data),
        Buffer.from(`${trailer}\r\n`)
      ])
      articles.push({
        messageId: `part${part}of${total}.${index}.${file.name.replace(/[^\w.-]/g, '_')}@plexo.test`,
        file: index,
        number: part,
        begin,
        data,
        body
      })
    }
  })
  return articles
}

/** A line that starts with a dot gets another (RFC 3977 §3.1.1), and the body ends with one. */
function dotStuffed(body: Buffer): Buffer {
  const parts: Buffer[] = []
  let from = 0
  if (body[0] === 0x2e) parts.push(Buffer.from('.'))
  for (let at = body.indexOf('\n.'); at >= 0; at = body.indexOf('\n.', at + 1)) {
    parts.push(body.subarray(from, at + 1), Buffer.from('.'))
    from = at + 1
  }
  parts.push(body.subarray(from), Buffer.from('.\r\n'))
  return Buffer.concat(parts)
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export class NewsServer {
  private readonly server: Server
  private readonly articles: Article[]
  private readonly byId = new Map<string, Article>()
  private readonly requests = new Map<string, number>()
  private readonly sockets = new Set<Socket>()
  private connections = 0
  readonly served: ServedArticle[] = []
  /** Connections turned away for going over maxConnections. */
  refused = 0
  port = 0

  constructor(private readonly options: NewsServerOptions) {
    this.articles = post(options.files, options.articleBytes ?? 16 * 1024)
    for (const article of this.articles) this.byId.set(article.messageId, article)
    this.server = createServer((socket) => this.accept(socket))
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '0.0.0.0', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  get articleCount(): number {
    return this.articles.length
  }

  /** The NZB listing every article, as an indexer would serve it. */
  nzb(): Buffer {
    const files = this.options.files.map((file, index) => {
      const articles = this.articles.filter((article) => article.file === index)
      const segments = articles
        .map(
          (article) =>
            `      <segment bytes="${article.body.length}" number="${article.number}">${escapeXml(article.messageId)}</segment>`
        )
        .join('\n')
      return `  <file poster="plexo@test" date="1700000000" subject="${escapeXml(`[${index + 1}/${this.options.files.length}] - "${file.name}" yEnc (1/${articles.length})`)}">
    <groups><group>alt.binaries.test</group></groups>
    <segments>
${segments}
    </segments>
  </file>`
    })
    return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nzb PUBLIC "-//newzBin//DTD NZB 1.1//EN" "http://www.newzbin.com/DTD/nzb/nzb-1.1.dtd">
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <head><meta type="name">Test release</meta></head>
${files.join('\n')}
</nzb>
`)
  }

  /** What a completed download's folder must hash to: the files, with each article the server
   * doesn't have (or `gaps` names) left as zeros. */
  expectedSha(
    gaps: (article: { file: number; number: number }) => boolean = (article) =>
      this.options.missing?.(article) ?? false
  ): string {
    const files = this.options.files.map((file, index) => {
      const data = Buffer.from(file.data)
      for (const article of this.articles) {
        if (article.file === index && gaps(article)) {
          data.fill(0, article.begin, article.begin + article.data.length)
        }
      }
      return { path: file.name, data }
    })
    return treeSha(files)
  }

  /** How many articles the server doesn't have. */
  get missingCount(): number {
    return this.articles.filter((article) => this.options.missing?.(article)).length
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    const connection = ++this.connections
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    const { maxConnections } = this.options
    if (maxConnections !== undefined && this.sockets.size > maxConnections) {
      this.refused++
      this.sockets.delete(socket)
      socket.end('502 Too many connections for this account\r\n')
      return
    }
    let signedIn = this.options.username === undefined
    let user = ''
    let buffered = ''
    socket.write('200 Plexo test news server ready\r\n')
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1')
      let end: number
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 2)
        const [command, ...rest] = line.split(' ')
        const argument = rest.join(' ')
        switch (command.toUpperCase()) {
          case 'AUTHINFO': {
            const [kind, ...value] = rest
            if (kind.toUpperCase() === 'USER') {
              user = value.join(' ')
              socket.write('381 Password required\r\n')
            } else if (
              user === this.options.username &&
              value.join(' ') === this.options.password
            ) {
              signedIn = true
              socket.write('281 Authentication accepted\r\n')
            } else {
              socket.write('481 Authentication failed\r\n')
            }
            break
          }
          case 'BODY': {
            const messageId = argument.replace(/^<|>$/g, '')
            if (!signedIn) socket.write('480 Authentication required\r\n')
            else if (this.options.delayMs) {
              setTimeout(() => this.body(socket, connection, messageId), this.options.delayMs)
            } else this.body(socket, connection, messageId)
            break
          }
          case 'QUIT':
            socket.end('205 Bye\r\n')
            return
          default:
            socket.write('500 Unknown command\r\n')
        }
      }
    })
  }

  private body(socket: Socket, connection: number, messageId: string): void {
    if (socket.destroyed) return
    const article = this.byId.get(messageId)
    const from = (socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (!article || this.options.missing?.(article)) {
      this.served.push({ messageId, from, connection, fault: 'missing' })
      socket.write('430 No such article\r\n')
      return
    }
    const request = (this.requests.get(messageId) ?? 0) + 1
    this.requests.set(messageId, request)
    const fault = this.options.fault?.(article, request) ?? 'ok'
    this.served.push({ messageId, from, connection, fault })
    let body = article.body
    if (fault === 'corrupt') {
      body = Buffer.from(body)
      // A data byte in the middle of the article: past the two header lines.
      const at = body.indexOf('\r\n', body.indexOf('\r\n') + 2) + 2 + 10
      body[at] = body[at] === 0x41 ? 0x42 : 0x41
    }
    const wire = Buffer.concat([Buffer.from(`222 0 <${messageId}>\r\n`), dotStuffed(body)])
    if (fault === 'cut' || fault === 'stall') {
      socket.write(wire.subarray(0, wire.length >> 1))
      if (fault === 'cut') socket.destroy()
      return
    }
    socket.write(wire)
  }
}
