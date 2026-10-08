import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { app } from 'electron'
import {
  BRIDGE_API,
  BRIDGE_DEADLINE_MS,
  BRIDGE_PORTS,
  type BridgeAddRequest,
  type BridgePing
} from '../shared/browserBridge'
import type { BrowserContext, ProbeResult } from '../shared/types'
import { browserContextFrom, requestHeaders } from './download/browserContext'
import type { DownloadManager } from './download/downloadManager'
import { probeUrl } from './download/probe'
import type { Offer } from './openLinks'
import { loadSettings, saveSettings } from './settings'

// HTTP on 127.0.0.1 works in every browser with nothing to register. There's no pairing: nothing
// here starts a download without the user, web pages can't get in (see handle), and a program on
// this computer could already do more.

const MAX_BODY_BYTES = 64 * 1024
// Any extension's origin: Firefox gives each install its own id, so ours can't be pinned.
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i

export interface BridgeHost {
  manager: DownloadManager
  offer: (offer: Offer) => void
}

let host: BridgeHost | null = null
let listeningOn: number | null = null
let extensionUsed = false

/** Once an extension has connected, closing the window keeps Plexo in the tray, where the
 * browser can still reach it. */
export function keepsRunningForBrowser(): boolean {
  return listeningOn !== null && extensionUsed
}

export async function startBridge(bridgeHost: BridgeHost): Promise<void> {
  host = bridgeHost
  extensionUsed = (await loadSettings()).browserExtensionUsed === true
  for (const port of BRIDGE_PORTS) {
    const server = createServer(
      (req, res) => void handle(req, res, port).catch(() => end(res, 500))
    )
    const listened = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (listened) {
      listeningOn = port
      return
    }
  }
  console.error(`[plexo] browser bridge: ports ${BRIDGE_PORTS.join(', ')} are all taken`)
}

function end(res: ServerResponse, code: number, headers: Record<string, string> = {}): void {
  if (!res.headersSent) res.writeHead(code, headers)
  res.end()
}

function json(
  res: ServerResponse,
  code: number,
  headers: Record<string, string>,
  body: unknown
): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(code, { ...headers, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  const origin = req.headers.origin
  // Host blocks DNS rebinding: a page whose domain resolves to 127.0.0.1 still sends its own name.
  // A missing Origin is allowed because a page's POST always sends one, and Firefox may leave it
  // off an extension's.
  const local = req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`
  if (!local || (origin && !EXTENSION_ORIGIN.test(origin))) {
    return end(res, 403)
  }
  const cors: Record<string, string> = origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST',
        Vary: 'Origin'
      }
    : {}
  if (req.method === 'OPTIONS') return end(res, 204, cors)
  const path = new URL(req.url ?? '/', 'http://local').pathname

  if (req.method === 'GET' && path === '/ping') {
    noteExtension()
    return json(res, 200, cors, {
      app: 'plexo',
      version: app.getVersion(),
      api: BRIDGE_API
    } satisfies BridgePing)
  }
  if (req.method === 'POST' && path === '/add') {
    // JSON only: a page can't send JSON here without a CORS preflight, which only an extension's
    // origin passes.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return end(res, 415, cors)
    const request = addRequestFrom(await readJson(req))
    if (!request) return end(res, 400, cors)
    noteExtension()
    return add(request, res, cors)
  }
  end(res, 404, cors)
}

function noteExtension(): void {
  if (extensionUsed) return
  extensionUsed = true
  void saveSettings({ browserExtensionUsed: true }).catch(() => {})
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  } catch {
    return null
  }
}

function addRequestFrom(body: unknown): BridgeAddRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { url, browser, pageUrl, minBytes } = body as Record<string, unknown>
  if (typeof url !== 'string' || url.length > 8192 || !/^(https?:\/\/|magnet:\?)/i.test(url)) {
    return null
  }
  const context = browser === undefined ? undefined : browserContextFrom(browser)
  if (context === null) return null
  if (pageUrl !== undefined && !(typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl))) {
    return null
  }
  if (minBytes !== undefined && !Number.isSafeInteger(minBytes)) return null
  return {
    url,
    browser: context,
    pageUrl: pageUrl as string | undefined,
    minBytes: minBytes as number | undefined
  }
}

/** The probe, or why the browser should keep the download. */
async function checked(
  request: BridgeAddRequest,
  gone: Promise<void>
): Promise<ProbeResult | string> {
  let timer: NodeJS.Timeout | undefined
  try {
    // ponytail: the probe isn't cancelled, only no longer waited for; it ends at its own timeout.
    return await Promise.race([
      probeUrl(request.url, request.browser),
      new Promise<string>((resolve) => {
        timer = setTimeout(resolve, BRIDGE_DEADLINE_MS, 'The server took too long to answer.')
      }),
      gone.then(() => 'gone')
    ])
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
}

async function add(
  request: BridgeAddRequest,
  res: ServerResponse,
  cors: Record<string, string>
): Promise<void> {
  if (!host) return end(res, 503, cors)
  const keep = (reason: string): void => json(res, 422, cors, { taken: false, reason })
  const taken = (): void => json(res, 200, cors, { taken: true })

  // A magnet link has nothing to check here: New download looks it up.
  if (/^magnet:/i.test(request.url)) {
    host.offer({ url: request.url })
    return taken()
  }

  const gone = new Promise<void>((resolve) =>
    res.once('close', () => !res.writableFinished && resolve())
  )
  const probe = await checked(request, gone)
  // The extension gave up and the browser kept the download: adding it too would make two. From
  // here on nothing awaits, so the answer can't come after the extension has stopped waiting.
  if (res.writableEnded || res.destroyed) return
  if (typeof probe === 'string') return keep(probe)
  if (
    probe.kind === 'http' &&
    request.minBytes !== undefined &&
    probe.totalBytes !== null &&
    probe.totalBytes < request.minBytes
  ) {
    return keep('smaller than the minimum size')
  }
  host.offer({
    url: request.url,
    probe,
    browser: request.browser,
    from: request.browser?.name,
    signedInTo: signedInTo(request, probe),
    resumes: probe.kind === 'http' ? host.manager.failedMatch(probe) : undefined
  })
  taken()
}

/** The page's site rather than the file's, which is often a CDN's: drive.google.com, not
 * drive.usercontent.google.com. */
function signedInTo(request: BridgeAddRequest, probe: ProbeResult): string | undefined {
  const browser: BrowserContext | undefined = request.browser
  const fileUrl = new URL(probe.finalUrl)
  if (!browser || !requestHeaders(fileUrl, browser)['Cookie']) return undefined
  return new URL(request.pageUrl ?? browser.referer ?? fileUrl).hostname
}
