import type { BridgeAddRequest } from '../../src/shared/browserBridge'
import { browserContext, reach, send, storeOf, wake, type Reach } from './plexo'
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
  await chrome.action.setIcon({ path: capture && reached === 'ok' ? ICON : ICON_OFF })
  await chrome.action.setTitle({ title })
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
  const sent = await send(request)
  if (sent !== 'taken') {
    if (sent === 'closed') await showState('closed')
    return false
  }
  await chrome.downloads.cancel(item.id).catch(() => {})
  await chrome.downloads.erase({ id: item.id }).catch(() => {})
  await closeEmptyTab([item.url, item.finalUrl])
  await showState('ok')
  return true
}

/** A link that opens a tab only to download leaves that tab empty once Plexo takes it. */
async function closeEmptyTab(urls: readonly (string | undefined)[]): Promise<void> {
  const recently = Date.now() - 30_000
  for (const tab of await chrome.tabs.query({})) {
    const shows = tab.pendingUrl ?? tab.url
    if (tab.id === undefined || shows === undefined || !urls.includes(shows)) continue
    if ((openedAt.get(tab.id) ?? 0) < recently) continue
    await chrome.tabs.remove(tab.id).catch(() => {})
  }
}

// In Chromium, answering later holds back the browser's own Save As dialog until Plexo has
// decided, so the user is never asked twice. Firefox has no such event.
const determining = chrome.downloads.onDeterminingFilename
if (determining) {
  determining.addListener((item, suggest) => {
    void capture(item).then((taken) => taken || suggest())
    return true
  })
} else {
  chrome.downloads.onCreated.addListener((item) => void capture(item))
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
  await showState(sent === 'taken' ? 'ok' : undefined)
}

// Run on install and on every browser start: menus and alarms don't always survive a restart.
function setUp(): void {
  createMenu()
  void chrome.alarms.create(CHECK_ALARM, { periodInMinutes: 0.5 })
  void showState()
}

function createMenu(): void {
  void chrome.contextMenus
    .removeAll()
    .then(() =>
      chrome.contextMenus.create({ id: MENU_ID, title: 'Download with Plexo', contexts: ['link'] })
    )
}

chrome.runtime.onInstalled.addListener(setUp)
chrome.runtime.onStartup.addListener(setUp)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void showState()
})
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) void sendLink(info, tab)
})
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) openedAt.set(tab.id, Date.now())
})
chrome.storage.onChanged.addListener(() => void showState())

chrome.runtime.onMessage.addListener((message) => {
  const { wakePlexo, checkPlexo } = message as { wakePlexo?: boolean; checkPlexo?: boolean }
  if (checkPlexo) void showState()
  if (wakePlexo) void wake().then((woke) => showState(woke ? 'ok' : 'closed'))
})
