import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { BrowserContext, PendingLink } from '../shared/types'

// Links the OS hands Plexo (a magnet link clicked in a browser, a .torrent opened from the file
// manager) or the browser extension does. They're never started on their own: the user still sees
// what the link is and presses Start.

/** The browser's sign-in stays in main: the window never sees it. */
export interface Offer extends Omit<PendingLink, 'id'> {
  browser?: BrowserContext
}

const queue: (Offer & { id: string })[] = []
const shown = new Map<string, BrowserContext>()

/** A magnet link, or the path of a .torrent file that exists; anything else isn't taken. */
export function acceptedLink(candidate: string): string | null {
  if (/^magnet:\?/i.test(candidate)) return candidate
  if (!isAbsolute(candidate) || !/\.torrent$/i.test(candidate)) return null
  try {
    return statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

/** The link in a command line (Windows and Linux hand one over as an argument). */
export function linkFromArgs(argv: readonly string[]): string | null {
  for (const argument of argv.slice(1)) {
    const link = acceptedLink(argument)
    if (link) return link
  }
  return null
}

/** Windows and macOS keep a background app from taking focus: Windows only flashes the taskbar
 * button unless the window is briefly on top, and macOS needs `steal`. */
export function bringForward(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  if (process.platform === 'win32') {
    window.setAlwaysOnTop(true)
    window.show()
    window.focus()
    window.setAlwaysOnTop(false)
    return
  }
  if (process.platform === 'darwin') app.focus({ steal: true })
  window.show()
  window.focus()
}

/** Queued, so a link that arrives before the window is ready isn't lost. */
export function offerLink(offer: Offer, window: BrowserWindow | null): void {
  queue.push({ ...offer, id: randomUUID() })
  if (!window || window.isDestroyed()) return
  bringForward(window)
  window.webContents.send(IpcChannels.linkReceived)
}

export function takePendingLinks(): PendingLink[] {
  return queue.splice(0).map(({ browser, ...link }) => {
    if (browser) shown.set(link.id, browser)
    return link
  })
}

export function shownBrowser(id: string): BrowserContext | undefined {
  return shown.get(id)
}

export function releaseLink(id: string): void {
  shown.delete(id)
}
