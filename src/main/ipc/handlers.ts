import { is } from '@electron-toolkit/utils'
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { IpcContract } from '../../shared/ipc-contract'
import type { NetworkInterfaceInfo, ThemeSource } from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { probeUrl } from '../download/probe'
import { deviceBindingSupported } from '../network/deviceBinding'
import { measureLatencies } from '../network/latency'
import { listActiveInterfaces } from '../network/interfaces'
import { loadNetworkPreferences, saveNetworkPreference } from '../network/preferences'
import {
  loadDismissedUpdateVersion,
  loadLastDownloadDir,
  saveDismissedUpdateVersion,
  saveLastDownloadDir,
  saveThemeSource
} from '../settings'
import { testKnobs } from '../testKnobs'
import { checkForUpdate, UPDATE_PAGE_URL } from '../updateCheck'

async function openNetworkSettings(): Promise<void> {
  if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:network-status')
  } else if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.network')
  } else if (process.platform === 'linux') {
    try {
      const { exec } = await import('node:child_process')
      exec('gnome-control-center network || nm-connection-editor || true')
    } catch {
      // Best-effort
    }
  }
}

/** Typed wrapper around ipcMain.handle — the channel name picks its args/result shape out of
 * IpcContract, so a handler here that doesn't match what plexoApi (preload) actually calls is a
 * compile error instead of a silent runtime mismatch. */
function handle<K extends keyof IpcContract>(
  channel: K,
  listener: (
    event: IpcMainInvokeEvent,
    ...args: IpcContract[K]['args']
  ) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>
): void {
  ipcMain.handle(
    IpcChannels[channel],
    listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  )
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): DownloadManager {
  let cachedInterfaces: NetworkInterfaceInfo[] = []

  const refreshInterfaces = async (): Promise<NetworkInterfaceInfo[]> => {
    cachedInterfaces = await listActiveInterfaces()
    return cachedInterfaces
  }

  const manager = new DownloadManager(
    getWindow,
    (id) => cachedInterfaces.find((iface) => iface.id === id),
    refreshInterfaces
  )

  handle('listInterfaces', refreshInterfaces)

  handle('pingInterfaces', async () => measureLatencies(cachedInterfaces))

  // Started now so it has settled before the first ping or download needs it.
  const bindingSupport = deviceBindingSupported()
  handle('deviceBindingSupported', async () => bindingSupport)

  handle('getNetworkPreferences', async () => loadNetworkPreferences())

  handle('setNetworkPreference', async (_event, id, patch) => saveNetworkPreference(id, patch))

  // The app only ever assigns 'light'/'dark' to nativeTheme.themeSource (main/index.ts's startup
  // call to loadThemeSource() never resolves to 'system') — narrow Electron's wider type here
  // rather than widening our own ThemeSource just to match it.
  const currentThemeSource = (): ThemeSource =>
    nativeTheme.themeSource === 'dark' ? 'dark' : 'light'

  handle('getThemeSource', async () => currentThemeSource())

  handle('setThemeSource', async (_event, source) => {
    nativeTheme.themeSource = source
    await saveThemeSource(source)
    return currentThemeSource()
  })

  handle('openNetworkSettings', async () => {
    await openNetworkSettings()
  })

  handle('probeUrl', async (_event, url) => probeUrl(url))

  handle('getInitialPaths', async () => {
    const lastDir = await loadLastDownloadDir()
    return {
      homeDir: getHomeDir(),
      downloadsDir: lastDir || getDefaultDownloadsDir(),
      isDev: is.dev
    }
  })

  handle('chooseDestinationFolder', async (_event, defaultPath) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const chosen = result.filePaths[0]
    await saveLastDownloadDir(chosen)
    return chosen
  })

  handle('chooseSourceFile', async () => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('readClipboardText', async () => clipboard.readText())

  handle('revealInFolder', async (_event, filePath) => {
    shell.showItemInFolder(filePath)
  })

  handle('startDownload', async (_event, request) => {
    if (request.destinationDir) {
      await saveLastDownloadDir(request.destinationDir)
    }
    return manager.start(request)
  })

  handle('startSimulatedDownload', async (_event, request) => manager.startSimulated(request))

  handle('getCurrentDownload', async () => manager.getCurrentDownload())

  handle('pauseDownload', async (_event, id) => {
    await manager.pause(id)
  })

  handle('resumeDownload', async (_event, id) => {
    manager.resume(id)
  })

  handle('cancelDownload', async (_event, id) => {
    manager.cancel(id)
  })

  handle('removeDownload', async (_event, id) => {
    manager.remove(id)
  })

  // Kicked off once at startup, not per-call — later renderer calls (e.g. a remount) just await
  // the same in-flight/settled check instead of re-hitting the GitHub API.
  const updateCheckPromise = (async () => {
    const info = testKnobs.forceUpdateVersion
      ? { version: testKnobs.forceUpdateVersion, url: UPDATE_PAGE_URL }
      : await checkForUpdate(app.getVersion())
    if (!info) return null
    const dismissedVersion = await loadDismissedUpdateVersion()
    return { ...info, dismissed: info.version === dismissedVersion }
  })()

  handle('checkForUpdate', async () => updateCheckPromise)

  handle('dismissUpdate', async (_event, version) => {
    await saveDismissedUpdateVersion(version)
  })

  return manager
}
