import { checkPlexoHealth, formatCookies, sendDownloadToPlexo } from './client.js'
import { DEFAULT_SETTINGS, extractFilename, shouldCaptureDownload } from './rules.js'

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

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError
    chrome.contextMenus.create(
      {
        id: 'plexo-download-link',
        title: 'Download with Plexo',
        contexts: ['link']
      },
      () => {
        void chrome.runtime.lastError
      }
    )

    chrome.contextMenus.create(
      {
        id: 'plexo-download-media',
        title: 'Download media with Plexo',
        contexts: ['video', 'audio']
      },
      () => {
        void chrome.runtime.lastError
      }
    )

    chrome.contextMenus.create(
      {
        id: 'plexo-download-image',
        title: 'Download image with Plexo',
        contexts: ['image']
      },
      () => {
        void chrome.runtime.lastError
      }
    )
  })
}

// Initial setup
chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().catch(() => {})
  setupContextMenus()
})

chrome.runtime.onStartup.addListener(() => {
  void loadSettings().catch(() => {})
  setupContextMenus()
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

  const urlFilename = extractFilename(targetUrl)
  const payload = {
    url: targetUrl,
    suggestedFileName: urlFilename || undefined,
    referer: tab?.url || info.pageUrl || undefined,
    cookies: cookieHeader || undefined,
    userAgent: navigator.userAgent
  }

  const result = await sendDownloadToPlexo(payload, settings.port)
  if (!result.success) {
    updateBadge()
  }
})

function cancelAndErase(downloadId) {
  if (downloadId === null || downloadId === undefined) return
  chrome.downloads.cancel(downloadId, () => {
    void chrome.runtime.lastError
    chrome.downloads.search({ id: downloadId }, (items) => {
      void chrome.runtime.lastError
      if (items && items.length > 0) {
        chrome.downloads.erase({ id: downloadId }, () => {
          void chrome.runtime.lastError
        })
      }
    })
  })
}

// Process a browser download event (onCreated or onDeterminingFilename)
async function processDownloadItem(downloadItem, suggest = null) {
  if (!downloadItem || downloadItem.id === null || downloadItem.id === undefined) {
    if (suggest) suggest()
    return
  }

  if (processedDownloadIds.has(downloadItem.id)) {
    if (suggest) suggest()
    return
  }

  const settings = await loadSettings()
  if (!settings.enabled) {
    if (suggest) suggest()
    return
  }

  if (!shouldCaptureDownload(downloadItem, settings)) {
    if (suggest) suggest()
    return
  }

  // Prevent duplicate capture across multiple events
  processedDownloadIds.add(downloadItem.id)
  setTimeout(() => processedDownloadIds.delete(downloadItem.id), 60000)

  const downloadUrl = downloadItem.finalUrl || downloadItem.url
  if (!downloadUrl) {
    if (suggest) suggest()
    return
  }

  let cookieHeader = ''
  try {
    const cookies = await chrome.cookies.getAll({ url: downloadUrl })
    cookieHeader = formatCookies(cookies)
  } catch {
    // Best-effort cookie retrieval
  }

  const rawFilename = downloadItem.filename
    ? downloadItem.filename.split(/[/\\]/).filter(Boolean).pop()
    : extractFilename(downloadUrl)

  const payload = {
    url: downloadUrl,
    suggestedFileName: rawFilename || undefined,
    referer: downloadItem.referrer || undefined,
    cookies: cookieHeader || undefined,
    userAgent: navigator.userAgent
  }

  const result = await sendDownloadToPlexo(payload, settings.port)

  if (result.success) {
    // Successfully transferred to Plexo: cancel and clean up the native browser download
    cancelAndErase(downloadItem.id)
  } else {
    // Plexo is offline or unavailable: let the browser download proceed normally
    updateBadge()
  }

  if (suggest) {
    suggest()
  }
}

// Intercept browser downloads on creation
chrome.downloads.onCreated.addListener((downloadItem) => {
  void processDownloadItem(downloadItem).catch(() => {})
})

// Also listen when filename is determined (for dynamic download URLs / Content-Disposition headers)
if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    void processDownloadItem(downloadItem, suggest).catch(() => {
      suggest()
    })
    return true
  })
}

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
