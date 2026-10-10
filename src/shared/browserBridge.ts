import type { BrowserContext } from './types'

// The extension imports this file too, so Plexo and the extension can't drift apart.

/** Plexo listens on the first that's free and the extension tries them all, so a port another app
 * holds needs no setting. */
export const BRIDGE_PORTS = [19288, 19289, 19290] as const
/** Raised when an older extension or Plexo couldn't follow a change to /ping or /add. */
export const BRIDGE_API = 1
/** The extension waits a little longer than this, and Plexo adds nothing once it has given up,
 * so a download never ends up in both. */
export const BRIDGE_DEADLINE_MS = 8000
// ponytail: one page linking every store; it must exist before the extension ships.
export const EXTENSION_PAGE_URL = 'https://getplexo.app/extension'

export interface BridgePing {
  app: 'plexo'
  version: string
  api: number
}

/** 200 with a BridgeHandoff: Plexo will take it. 422: the browser keeps it. Never held past the
 * deadline: Chrome stops an extension's service worker when a fetch takes over 30 s. */
export interface BridgeAddRequest {
  url: string
  browser?: BrowserContext
  pageUrl?: string
  minBytes?: number
  /** The name the browser picked: only it saw a link's download attribute. */
  fileName?: string
}

/** Plexo shows the download only once POST /confirm brings this back: the extension confirms
 * after the browser's copy is really gone, since it can finish before it's cancelled. Unconfirmed,
 * it expires and Plexo shows nothing, so a download never ends up in both. */
export interface BridgeHandoff {
  token: string
}
