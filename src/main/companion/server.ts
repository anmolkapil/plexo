import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { CompanionDownloadPayload } from '../../shared/types'

export const DEFAULT_COMPANION_PORT = 41829
const MAX_BODY_BYTES = 1024 * 1024 // 1 MB
const configuredTrustedOrigins = (process.env['PLEXO_COMPANION_ORIGINS'] || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

export const EXTENSION_ORIGIN_REGEX =
  /^(chrome-extension|moz-extension|safari-web-extension|extension):\/\/[a-z0-9-]+$/i

export function isAllowedOrigin(
  origin?: string,
  trustedOrigins: readonly string[] = configuredTrustedOrigins
): boolean {
  if (!origin) return false
  if (trustedOrigins.length > 0) {
    return trustedOrigins.includes(origin)
  }
  return EXTENSION_ORIGIN_REGEX.test(origin)
}

function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  trustedOrigins: readonly string[] = configuredTrustedOrigins
): void {
  const origin = req.headers.origin
  if (origin && isAllowedOrigin(origin, trustedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Plexo-Companion')
  }
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  trustedOrigins: readonly string[] = configuredTrustedOrigins
): void {
  setCorsHeaders(req, res, trustedOrigins)
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let received = 0

    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        req.destroy(new Error('Payload too large'))
        reject(new Error('Payload too large'))
        return
      }
      body += chunk.toString('utf-8')
    })

    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export class CompanionServer {
  private server: Server | null = null
  private listeningPort: number | null = null

  constructor(
    private getWindow: () => BrowserWindow | null,
    private hasActiveDownload: () => boolean,
    private port: number = DEFAULT_COMPANION_PORT,
    private trustedOrigins: readonly string[] = configuredTrustedOrigins
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const origin = req.headers.origin
        if (origin && !isAllowedOrigin(origin, this.trustedOrigins)) {
          sendJson(req, res, 403, { error: 'Forbidden: Untrusted origin' }, this.trustedOrigins)
          return
        }

        if (
          req.headers['sec-fetch-site'] === 'cross-site' &&
          !isAllowedOrigin(origin, this.trustedOrigins)
        ) {
          sendJson(
            req,
            res,
            403,
            { error: 'Forbidden: Untrusted cross-site request' },
            this.trustedOrigins
          )
          return
        }

        setCorsHeaders(req, res, this.trustedOrigins)

        if (req.method === 'OPTIONS') {
          if (!isAllowedOrigin(origin, this.trustedOrigins)) {
            sendJson(req, res, 403, { error: 'Forbidden: Untrusted origin' }, this.trustedOrigins)
            return
          }
          res.writeHead(204)
          res.end()
          return
        }

        const host = req.headers.host || ''
        const isLocalHost = /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host)
        if (!isLocalHost) {
          sendJson(req, res, 403, { error: 'Forbidden: Invalid Host header' }, this.trustedOrigins)
          return
        }

        const url = new URL(req.url || '/', `http://${host || '127.0.0.1'}`)

        if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
          sendJson(
            req,
            res,
            200,
            {
              status: 'ok',
              app: 'Plexo',
              version: app?.getVersion ? app.getVersion() : '1.0.0',
              hasActiveDownload: this.hasActiveDownload()
            },
            this.trustedOrigins
          )
          return
        }

        if (req.method === 'POST' && url.pathname === '/focus') {
          const window = this.getWindow()
          if (window && !window.isDestroyed()) {
            if (window.isMinimized()) window.restore()
            if (!window.isVisible()) window.show()
            window.focus()
          }
          if (!window || window.isDestroyed()) {
            sendJson(
              req,
              res,
              409,
              { success: false, error: 'Plexo window is unavailable' },
              this.trustedOrigins
            )
            return
          }
          sendJson(req, res, 200, { success: true }, this.trustedOrigins)
          return
        }

        if (req.method === 'POST' && url.pathname === '/download') {
          try {
            const rawBody = await parseBody(req)
            const payload = (rawBody ? JSON.parse(rawBody) : {}) as CompanionDownloadPayload

            if (!payload.url || !/^https?:/i.test(payload.url.trim())) {
              sendJson(
                req,
                res,
                400,
                {
                  error: 'Invalid URL. Only HTTP and HTTPS URLs are supported.'
                },
                this.trustedOrigins
              )
              return
            }

            // Normalise headers: merge explicit headers with cookies/referer/userAgent if provided
            const headers: Record<string, string> = { ...(payload.headers ?? {}) }
            if (payload.cookies && !headers['Cookie'] && !headers['cookie']) {
              headers['Cookie'] = payload.cookies
            }
            if (payload.referer && !headers['Referer'] && !headers['referer']) {
              headers['Referer'] = payload.referer
            }
            if (payload.userAgent && !headers['User-Agent'] && !headers['user-agent']) {
              headers['User-Agent'] = payload.userAgent
            }

            const cleanPayload: CompanionDownloadPayload = {
              url: payload.url.trim(),
              suggestedFileName: payload.suggestedFileName?.trim() || undefined,
              cookies: payload.cookies,
              referer: payload.referer,
              userAgent: payload.userAgent,
              headers: Object.keys(headers).length > 0 ? headers : undefined
            }

            this.deliverPayload(cleanPayload)

            sendJson(
              req,
              res,
              200,
              {
                success: true,
                message: 'Download received by Plexo',
                hasActiveDownload: this.hasActiveDownload()
              },
              this.trustedOrigins
            )
          } catch (error) {
            sendJson(
              req,
              res,
              400,
              {
                error: error instanceof Error ? error.message : 'Malformed JSON request body'
              },
              this.trustedOrigins
            )
          }
          return
        }

        sendJson(req, res, 404, { error: 'Endpoint not found' }, this.trustedOrigins)
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(
            `[Plexo Companion] Port ${this.port} is already in use. Companion server disabled.`
          )
          resolve(0)
        } else {
          reject(err)
        }
      })

      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address()
        const actualPort = typeof address === 'object' && address ? address.port : this.port
        this.listeningPort = actualPort
        this.server = server
        console.log(`[Plexo Companion] Listening for browser extension on 127.0.0.1:${actualPort}`)
        resolve(actualPort)
      })
    })
  }

  deliverPayload(payload: CompanionDownloadPayload): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return

    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    if (typeof window.setAlwaysOnTop === 'function') {
      window.setAlwaysOnTop(true)
      window.focus()
      window.setAlwaysOnTop(false)
    } else {
      window.focus()
    }

    window.webContents.send(IpcChannels.companionDownload, payload)
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close(() => {
        this.server = null
        this.listeningPort = null
        resolve()
      })
    })
  }

  getPort(): number | null {
    return this.listeningPort
  }
}
