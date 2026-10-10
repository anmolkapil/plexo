import { api } from './api'
import {
  BRIDGE_API,
  BRIDGE_DEADLINE_MS,
  BRIDGE_PORTS,
  type BridgeAddRequest,
  type BridgeHandoff,
  type BridgePing
} from '../../src/shared/browserBridge'
import type { BrowserContext, BrowserCookie } from '../../src/shared/types'

export type Reach = 'ok' | 'closed' | 'update'

let found: number | null = null

/** Anything other than Plexo holding the port counts as closed. */
async function ask(port: number): Promise<Reach> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ping`, {
      signal: AbortSignal.timeout(1500)
    })
    const ping = (await response.json()) as Partial<BridgePing>
    if (!response.ok || ping.app !== 'plexo') return 'closed'
    return ping.api === BRIDGE_API ? 'ok' : 'update'
  } catch {
    return 'closed'
  }
}

export function plexoPort(): number | null {
  return found
}

export async function reach(): Promise<Reach> {
  const answers = await Promise.all(BRIDGE_PORTS.map(ask))
  const at = answers.indexOf('ok')
  found = at >= 0 ? BRIDGE_PORTS[at] : null
  return at >= 0 ? 'ok' : answers.includes('update') ? 'update' : 'closed'
}

/** Plexo will take the download once confirmed (see BridgeHandoff). */
export interface Handoff {
  port: number
  token: string
}

/** kept: Plexo said no, or took too long. */
export async function send(request: BridgeAddRequest): Promise<Handoff | 'kept' | 'closed'> {
  // Asked first every time, so the sign-in only ever goes to a port that has just answered as
  // Plexo, never to another app that has since taken it.
  if ((await reach()) !== 'ok' || found === null) return 'closed'
  const port = found
  try {
    const response = await fetch(`http://127.0.0.1:${port}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      // Past Plexo's own deadline: Plexo answers nothing once this has given up.
      signal: AbortSignal.timeout(BRIDGE_DEADLINE_MS + 2000)
    })
    if (!response.ok) return 'kept'
    const { token } = (await response.json()) as BridgeHandoff
    return { port, token }
  } catch (error) {
    return error instanceof DOMException && error.name === 'TimeoutError' ? 'kept' : 'closed'
  }
}

export async function confirm({ port, token }: Handoff): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3000)
    })
    return response.ok
  } catch {
    return false
  }
}

/** Firefox names its containers and private windows; Chrome's incognito store is "1". */
export function storeOf(source: {
  incognito: boolean
  cookieStoreId?: string
}): string | undefined {
  return source.cookieStoreId ?? (source.incognito ? '1' : undefined)
}

/** Cookies for where the download starts and where its redirects end; Plexo sends each request
 * only the ones that match it. */
export async function browserContext(
  urls: readonly (string | undefined)[],
  storeId: string | undefined,
  referer: string | undefined
): Promise<BrowserContext> {
  const cookies = new Map<string, BrowserCookie>()
  for (const url of new Set(urls)) {
    if (!url || !/^https?:/i.test(url)) continue
    const found = await api.cookies.getAll({ url, storeId }).catch(() => [])
    for (const { name, value, domain, hostOnly, path, secure } of found) {
      cookies.set(`${domain}\n${path}\n${name}`, { name, value, domain, hostOnly, path, secure })
    }
  }
  return {
    cookies: [...cookies.values()],
    ...(referer && /^https?:/i.test(referer) && { referer }),
    userAgent: navigator.userAgent,
    name: browserName()
  }
}

function browserName(): string {
  const agent = navigator.userAgent
  if (/Firefox\//.test(agent)) return 'Firefox'
  if (/Edg\//.test(agent)) return 'Edge'
  if (/OPR\//.test(agent)) return 'Opera'
  if (/Vivaldi\//.test(agent)) return 'Vivaldi'
  if ('brave' in navigator) return 'Brave'
  return 'Chrome'
}

/** Only ever on a click: the browser asks the user whether to open the app. */
export async function wake(): Promise<boolean> {
  const tab = await api.tabs.create({ url: 'plexo://open' })
  let reached = false
  for (let tries = 0; tries < 20 && !reached; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    reached = (await reach()) === 'ok'
  }
  if (reached && tab.id !== undefined) await api.tabs.remove(tab.id).catch(() => {})
  return reached
}
