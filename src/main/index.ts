import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon-dark.png?asset'
import { registerIpcHandlers } from './ipc/handlers'
import { loadThemeSource, migrateLegacyNetworkPreferences } from './settings'
import { testKnobs } from './testKnobs'
import type { DownloadManager } from './download/downloadManager'
import { CompanionServer } from './companion/server'

// In dev mode the app runs as the raw `electron` binary, which otherwise shows "Electron" in
// the Dock tooltip/menu bar — must be set before the app is ready. Packaged builds already get
// this from electron-builder's productName, but setting it here keeps dev and packaged in sync.
app.setName('Plexo')

// Each e2e test runs against its own throwaway userData folder (downloads, manifests, settings).
if (testKnobs.userDataDir) app.setPath('userData', testKnobs.userDataDir)

const isTesting = Boolean(testKnobs.userDataDir)
let mainWindow: BrowserWindow | null = null
let downloadManager: DownloadManager | null = null
let companionServer: CompanionServer | null = null
let quitAfterSuspending = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    title: 'Plexo',
    // Matches the renderer's dark-mode background so a live window resize
    // (which briefly exposes the raw window background) doesn't flash white.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    ...(process.platform !== 'darwin' ? { icon } : {}),
    // Design v2 draws its own logo + status readout where the title normally sits — on macOS,
    // keep the real traffic lights (still native, still draggable) but let the renderer's own
    // title bar occupy the rest of the strip instead of an OS-drawn title.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // A hidden e2e window would otherwise have its timers throttled.
      backgroundThrottling: !testKnobs.hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!testKnobs.hideWindow) mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only hand http(s) links to the OS shell — an arbitrary scheme (e.g. a custom protocol
    // handler) reaching shell.openExternal is a known Electron risk if this ever fires with
    // attacker- or server-influenced data.
    if (/^https?:/i.test(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.plexo.app')

  // A failed move keeps the old file, to retry next launch — it must never stop the window opening.
  await migrateLegacyNetworkPreferences().catch((error) =>
    console.error('[plexo] failed to migrate network-preferences.json', error)
  )

  // Applied before the window is created so the initial background/icon already match —
  // the saved preference otherwise only takes effect on the next 'updated' event.
  nativeTheme.themeSource = await loadThemeSource()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  downloadManager = registerIpcHandlers(() => mainWindow)

  companionServer = new CompanionServer(
    () => mainWindow,
    () => downloadManager?.hasActiveDownload() ?? false
  )
  if (!isTesting) {
    void companionServer.start()
  }

  nativeTheme.on('updated', () => {
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
  })

  createWindow()
  if (testKnobs.hideWindow) app.dock?.hide()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (companionServer) {
    void companionServer.stop()
  }
  if (quitAfterSuspending || !downloadManager) return

  event.preventDefault()

  // Guarantee the process exits even if suspending hangs
  const forceQuitTimeout = setTimeout(() => {
    app.exit(0)
  }, 3000)

  void downloadManager.suspendAll().finally(() => {
    clearTimeout(forceQuitTimeout)
    quitAfterSuspending = true
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
