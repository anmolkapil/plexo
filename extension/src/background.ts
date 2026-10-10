import { api } from './api'
import type { BridgeAddRequest } from '../../src/shared/browserBridge'
import { browserContext, confirm, reach, send, storeOf, wake, type Reach } from './plexo'
import { excluded, loadSettings } from './settings'

const MENU_ID = 'download-with-plexo'
// Plexo can't tell the extension it has quit, so the toolbar icon checks on a timer.
const CHECK_ALARM = 'check-plexo'

const openedAt = new Map<number, number>()

const ICON = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' }
// A greyed-out icon rather than a badge: the browser draws badges too small to notice.
const ICON_OFF = { 16: 'icons/icon-off-16.png', 32: 'icons/icon-off-32.png' }

async function showState(reached?: Reach): Promise<void> {
  const { capture } = await loadSettings()
  reached ??= await reach()
  const title = !capture
    ? 'Plexo: capture is off'
    : reached === 'closed'
      ? 'Plexo isn’t open: downloads stay in the browser'
      : reached === 'update'
        ? 'Update Plexo to use this extension'
        : 'Plexo'
  await api.action.setIcon({ path: capture && reached === 'ok' ? ICON : ICON_OFF })
  await api.action.setTitle({ title })
}

/** True when Plexo took the download; otherwise the browser keeps it. */
async function capture(item: chrome.downloads.DownloadItem): Promise<boolean> {
  const settings = await loadSettings()
  const url = item.finalUrl || item.url
  // blob: and data: downloads exist only inside the browser.
  if (!settings.capture || !/^https?:/i.test(url)) return false
  if (excluded(settings.sites, [item.url, item.finalUrl, item.referrer])) return false

  const request: BridgeAddRequest = {
    url,
    browser: await browserContext([item.url, item.finalUrl], storeOf(item), item.referrer),
    pageUrl: item.referrer || undefined,
    minBytes: settings.skipSmall ? settings.minMegabytes * 1024 * 1024 : undefined
  }
  const handoff = await send(request)
  if (typeof handoff === 'string') {
    if (handoff === 'closed') await showState('closed')
    return false
  }
  // Plexo shows the download only once the browser's copy is gone. Firefox can't hold a download
  // while Plexo checks it, so a small one may have finished meanwhile: cancelling then does
  // nothing, and the browser keeps it rather than both ending up with it.
  await api.downloads.cancel(item.id).catch(() => {})
  const [after] = await api.downloads.search({ id: item.id }).catch(() => [])
  if (after?.state === 'complete') return false
  await api.downloads.erase({ id: item.id }).catch(() => {})
  const shown = await confirm(handoff)
  await closeEmptyTab([item.url, item.finalUrl])
  await showState(shown ? 'ok' : undefined)
  return true
}

/** A link that opens a tab only to download leaves that tab empty once Plexo takes it. */
async function closeEmptyTab(urls: readonly (string | undefined)[]): Promise<void> {
  const recently = Date.now() - 30_000
  for (const tab of await api.tabs.query({})) {
    const shows = tab.pendingUrl ?? tab.url
    if (tab.id === undefined || shows === undefined || !urls.includes(shows)) continue
    if ((openedAt.get(tab.id) ?? 0) < recently) continue
    await api.tabs.remove(tab.id).catch(() => {})
  }
}

// In Chromium, answering later holds back the browser's own Save As dialog until Plexo has
// decided, so the user is never asked twice. Firefox has no such event.
const determining = api.downloads.onDeterminingFilename
if (determining) {
  determining.addListener((item, suggest) => {
    void capture(item).then((taken) => taken || suggest())
    return true
  })
} else {
  api.downloads.onCreated.addListener((item) => void capture(item))
}

/** Sent whatever the settings say, and Plexo is started if needed: the user asked for it. */
async function sendLink(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab
): Promise<void> {
  const url = info.linkUrl
  if (!url) return
  const request: BridgeAddRequest = /^magnet:/i.test(url)
    ? { url }
    : {
        url,
        browser: await browserContext([url], tab && storeOf(tab), info.pageUrl),
        pageUrl: info.pageUrl
      }
  let sent = await send(request)
  if (sent === 'closed' && (await wake())) sent = await send(request)
  // No browser copy to cancel first.
  const shown = typeof sent !== 'string' && (await confirm(sent))
  await showState(shown ? 'ok' : undefined)
}

// Run on install and on every browser start: menus and alarms don't always survive a restart.
function setUp(): void {
  createMenu()
  void api.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 })
  void showState()
}

function createMenu(): void {
  void api.contextMenus
    .removeAll()
    .then(() =>
      api.contextMenus.create({ id: MENU_ID, title: 'Download with Plexo', contexts: ['link'] })
    )
}

api.runtime.onInstalled.addListener(setUp)
api.runtime.onStartup.addListener(setUp)
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void showState()
})
api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void sendLink(info, tab)
})
api.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) openedAt.set(tab.id, Date.now())
})
api.storage.onChanged.addListener(() => void showState())

api.runtime.onMessage.addListener((message) => {
  const { wakePlexo, checkPlexo } = message as { wakePlexo?: boolean; checkPlexo?: boolean }
  if (checkPlexo) void showState()
  if (wakePlexo) void wake().then((woke) => showState(woke ? 'ok' : 'closed'))
})
