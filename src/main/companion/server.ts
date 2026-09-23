import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { CompanionDownloadPayload } from '../../shared/types'

export const DEFAULT_COMPANION_PORT = 41829
const MAX_BODY_BYTES = 1024 * 1024 // 1 MB

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With')
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  setCorsHeaders(res)
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
    private port: number = DEFAULT_COMPANION_PORT
  ) {}

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        setCorsHeaders(res)

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        const host = req.headers.host || ''
        const isLocalHost = /^127\.0\.0\.1(:\d+)?$/.test(host) || /^localhost(:\d+)?$/.test(host)
        if (!isLocalHost) {
          sendJson(res, 403, { error: 'Forbidden: Invalid Host header' })
          return
        }

        const url = new URL(req.url || '/', `http://${host || '127.0.0.1'}`)

        if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
          sendJson(res, 200, {
            status: 'ok',
            app: 'Plexo',
            version: app.getVersion(),
            hasActiveDownload: this.hasActiveDownload()
          })
          return
        }

        if (req.method === 'POST' && url.pathname === '/download') {
          try {
            const rawBody = await parseBody(req)
            const payload = (rawBody ? JSON.parse(rawBody) : {}) as CompanionDownloadPayload

            if (!payload.url || !/^https?:/i.test(payload.url.trim())) {
              sendJson(res, 400, {
                error: 'Invalid URL. Only HTTP and HTTPS URLs are supported.'
              })
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

            sendJson(res, 200, {
              success: true,
              message: 'Download received by Plexo',
              hasActiveDownload: this.hasActiveDownload()
            })
          } catch (error) {
            sendJson(res, 400, {
              error: error instanceof Error ? error.message : 'Malformed JSON request body'
            })
          }
          return
        }

        sendJson(res, 404, { error: 'Endpoint not found' })
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[Plexo Companion] Port ${this.port} is already in use. Companion server disabled.`)
          resolve(0)
        } else {
          reject(err)
        }
      })

      server.listen(this.port, '127.0.0.1', () => {
        this.listeningPort = this.port
        this.server = server
        console.log(`[Plexo Companion] Listening for browser extension on 127.0.0.1:${this.port}`)
        resolve(this.port)
      })
    })
  }

  deliverPayload(payload: CompanionDownloadPayload): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return

    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()

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
