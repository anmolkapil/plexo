import { checkPlexoHealth, formatCookies, sendDownloadToPlexo } from './client.js'
import { DEFAULT_SETTINGS, shouldCaptureDownload } from './rules.js'

let currentSettings = { ...DEFAULT_SETTINGS }
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.plexoSettings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...changes.plexoSettings.newValue }
    updateBadge()
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
  void loadSettings()

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
  void loadSettings()
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
    // Plexo desktop might not be running: attempt to open deep link as fallback
    const fallbackUrl = `plexo://download?url=${encodeURIComponent(targetUrl)}&referer=${encodeURIComponent(payload.referer || '')}`
    chrome.tabs.create({ url: fallbackUrl }, (newTab) => {
      setTimeout(() => {
        if (newTab?.id) chrome.tabs.remove(newTab.id)
      }, 1000)
    })
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
      chrome.downloads.erase({ id: downloadItem.id })
    })
  } else {
    // Plexo is offline or unavailable: let the browser download proceed normally!
    updateBadge()
  }
})

// Handle messages from popup / options
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'checkHealth') {
    void checkPlexoHealth(message.port || currentSettings.port).then((res) => sendResponse(res))
    return true
  }

  if (message.action === 'sendDownload') {
    void (async () => {
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
      const res = await sendDownloadToPlexo(payload, currentSettings.port)
      sendResponse(res)
    })()
    return true
  }

  if (message.action === 'getSettings') {
    sendResponse(currentSettings)
    return false
  }
})
