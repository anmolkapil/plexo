import { checkPlexoHealth, formatCookies, sendDownloadToPlexo } from './client.js'
import { DEFAULT_SETTINGS, shouldCaptureDownload } from './rules.js'

let currentSettings = { ...DEFAULT_SETTINGS }
let settingsPromise = null
const processedDownloadIds = new Set()

async function loadSettings() {
  const data = await chrome.storage.local.get(['plexoSettings'])
  if (data.plexoSettings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...data.plexoSettings }
  } else {
    currentSettings = { ...DEFAULT_SETTINGS }
    await chrome.storage.local.set({ plexoSettings: currentSettings })
  }
  updateBadge()
  return currentSettings
}

settingsPromise = loadSettings().catch(() => {
  currentSettings = { ...DEFAULT_SETTINGS }
  return currentSettings
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.plexoSettings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.plexoSettings.newValue }
    void updateBadge().catch(() => {})
  }
})

async function updateBadge() {
  if (!currentSettings.enabled) {
    chrome.action.setBadgeText({ text: 'PAUSE' })
    chrome.action.setBadgeBackgroundColor({ color: '#71717a' })
    return
  }

  const health = await checkPlexoHealth(currentSettings.port)
  if (health.online) {
    chrome.action.setBadgeText({ text: '' })
  } else {
    chrome.action.setBadgeText({ text: 'OFF' })
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
  }
}

// Initial setup
chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().catch(() => {})

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'plexo-download-link',
      title: 'Download with Plexo',
      contexts: ['link']
    })

    chrome.contextMenus.create({
      id: 'plexo-download-media',
      title: 'Download media with Plexo',
      contexts: ['video', 'audio']
    })

    chrome.contextMenus.create({
      id: 'plexo-download-image',
      title: 'Download image with Plexo',
      contexts: ['image']
    })
  })
})

chrome.runtime.onStartup.addListener(() => {
  void loadSettings().catch(() => {})
})

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.srcUrl
  if (!targetUrl || !/^https?:/i.test(targetUrl)) return

  const settings = await loadSettings()
  let cookieHeader = ''
  try {
    const cookies = await chrome.cookies.getAll({ url: targetUrl })
    cookieHeader = formatCookies(cookies)
  } catch {
    // Best-effort cookie retrieval
  }

  const payload = {
    url: targetUrl,
    referer: tab?.url || info.pageUrl || undefined,
    cookies: cookieHeader || undefined,
    userAgent: navigator.userAgent
  }

  const result = await sendDownloadToPlexo(payload, settings.port)
  if (!result.success) {
    updateBadge()
  }
})

// Intercept browser downloads
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (processedDownloadIds.has(downloadItem.id)) return

  const settings = await loadSettings()
  if (!settings.enabled) return

  if (!shouldCaptureDownload(downloadItem, settings)) return

  // Prevent recursive interception loops
  processedDownloadIds.add(downloadItem.id)
  setTimeout(() => processedDownloadIds.delete(downloadItem.id), 30000)

  const downloadUrl = downloadItem.finalUrl || downloadItem.url
  if (!downloadUrl) return

  let cookieHeader = ''
  try {
    const cookies = await chrome.cookies.getAll({ url: downloadUrl })
    cookieHeader = formatCookies(cookies)
  } catch {
    // Best-effort cookie retrieval
  }

  const rawFilename = downloadItem.filename ? downloadItem.filename.split(/[/\\]/).pop() : undefined
  const payload = {
    url: downloadUrl,
    suggestedFileName: rawFilename,
    referer: downloadItem.referrer || undefined,
    cookies: cookieHeader || undefined,
    userAgent: navigator.userAgent
  }

  const result = await sendDownloadToPlexo(payload, settings.port)

  if (result.success) {
    // Successfully transferred to Plexo: cancel the native browser download
    chrome.downloads.cancel(downloadItem.id, () => {
      chrome.downloads.search({ id: downloadItem.id }, (items) => {
        if (chrome.runtime.lastError || items.length === 0 || items[0].state === 'complete') return
        chrome.downloads.erase({ id: downloadItem.id }, () => {})
      })
    })
  } else {
    // Plexo is offline or unavailable: let the browser download proceed normally!
    updateBadge()
  }
})

// Handle messages from popup / options
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'checkHealth') {
    void (async () => {
      try {
        const settings = await (settingsPromise || loadSettings())
        const res = await checkPlexoHealth(message.port || settings.port)
        sendResponse(res)
      } catch (error) {
        sendResponse({ online: false, error: error instanceof Error ? error.message : 'Could not load settings' })
      }
    })()
    return true
  }

  if (message.action === 'sendDownload') {
    void (async () => {
      try {
        const settings = await (settingsPromise || loadSettings())
        let cookieHeader = ''
        try {
          const cookies = await chrome.cookies.getAll({ url: message.url })
          cookieHeader = formatCookies(cookies)
        } catch {
          // ignore
        }

        const payload = {
          url: message.url,
          cookies: cookieHeader || undefined,
          userAgent: navigator.userAgent
        }
        const res = await sendDownloadToPlexo(payload, settings.port)
        sendResponse(res)
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Could not load settings' })
      }
    })()
    return true
  }

  if (message.action === 'getSettings') {
    void (async () => {
      try {
        const settings = await (settingsPromise || loadSettings())
        sendResponse(settings)
      } catch (error) {
        sendResponse({ ...DEFAULT_SETTINGS, error: error instanceof Error ? error.message : 'Could not load settings' })
      }
    })()
    return true
  }
})
