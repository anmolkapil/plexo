import { stat } from 'node:fs/promises'
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type { IpcContract } from '../../shared/ipc-contract'
import type { InitialState, ThemeSource } from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { probeUrl } from '../download/probe'
import { deviceBindingSupported } from '../network/deviceBinding'
import { measureLatencies } from '../network/latency'
import { NetworkMonitor } from '../network/interfaces'
import { loadSettings, saveSettings } from '../settings'
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

const DESTINATION_CHECK_MS = 300

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): DownloadManager {
  // The main process keeps the network list, for downloads and the window alike.
  const networks = new NetworkMonitor((list) => {
    manager.networksChanged()
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.networksChanged, list)
  })
  const manager = new DownloadManager(getWindow, networks)
  // Waking from sleep, the networks may have changed without a poll in between to see it.
  powerMonitor.on('resume', () => {
    manager.systemResumed()
    void networks.refresh()
  })

  handle('listInterfaces', () => networks.refresh())

  handle('pingInterfaces', async () => measureLatencies(networks.current ?? []))

  // Started now so it has settled before the first ping or download needs it.
  const bindingSupport = deviceBindingSupported()
  handle('deviceBindingSupported', async () => bindingSupport)

  // The app only ever assigns 'light'/'dark' to nativeTheme.themeSource (main/index.ts's startup
  // call to loadThemeSource() never resolves to 'system') — narrow Electron's wider type here
  // rather than widening our own ThemeSource just to match it.
  const currentThemeSource = (): ThemeSource =>
    nativeTheme.themeSource === 'dark' ? 'dark' : 'light'

  handle('updateSettings', async (_event, patch) => {
    // The one setting main also applies — before saving, so a failed write still switches the
    // window to the theme the toggle now shows.
    if (patch?.themeSource === 'light' || patch?.themeSource === 'dark') {
      nativeTheme.themeSource = patch.themeSource
    }
    await saveSettings(patch)
  })

  // Answered via sendSync from the preload, which blocks the page until returnValue is set — so a
  // throw here must still reply (with no saved values) rather than leave the window never showing.
  ipcMain.on(IpcChannels.getInitialState, async (event) => {
    try {
      const settings = await loadSettings()
      const { destinationDir } = settings
      // Capped: a folder on a dropped network share can take many seconds to answer, and launch
      // waits on this reply — past the cap it's treated as gone and Downloads is used instead.
      const destinationExists =
        destinationDir !== undefined &&
        (await Promise.race([
          stat(destinationDir).then(
            (stats) => stats.isDirectory(),
            () => false
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, DESTINATION_CHECK_MS, false))
        ]))
      event.returnValue = {
        homeDir: getHomeDir(),
        downloadsDir: getDefaultDownloadsDir(),
        themeSource: currentThemeSource(),
        networkPreferences: settings.networkPreferences ?? {},
        destinationDir: destinationExists ? destinationDir : undefined
      } satisfies InitialState
    } catch (error) {
      console.error('[plexo] failed to read initial state', error)
      // No getPath() here — it may be what threw. An empty destination just keeps Start disabled.
      event.returnValue = {
        homeDir: '',
        downloadsDir: '',
        themeSource: currentThemeSource(),
        networkPreferences: {}
      } satisfies InitialState
    }
  })

  handle('openNetworkSettings', async () => {
    await openNetworkSettings()
  })

  handle('probeUrl', async (_event, url, headers) => probeUrl(url, headers))

  handle('chooseDestinationFolder', async (_event, defaultPath) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('readClipboardText', async () => clipboard.readText())

  handle('revealInFolder', async (_event, filePath) => {
    shell.showItemInFolder(filePath)
  })

  handle('startDownload', async (_event, request) => manager.start(request))

  handle('getCurrentDownload', async () => manager.getCurrentDownload())

  handle('pauseDownload', async (_event, id) => {
    await manager.pause(id)
  })

  handle('resumeDownload', async (_event, id) => {
    manager.resume(id)
  })

  handle('setDownloadNetwork', async (_event, id, networkId, enabled) => {
    manager.setNetworkEnabled(id, networkId, enabled)
  })

  handle('cancelDownload', async (_event, id) => manager.cancel(id))

  handle('removeDownload', async (_event, id) => manager.remove(id))

  // Kicked off once at startup, not per-call — later renderer calls (e.g. a remount) just await
  // the same in-flight/settled check instead of re-hitting the GitHub API.
  const updateCheckPromise = (async () => {
    const info = testKnobs.forceUpdateVersion
      ? { version: testKnobs.forceUpdateVersion, url: UPDATE_PAGE_URL }
      : await checkForUpdate(app.getVersion())
    return info
  })()

  // Dismissal is read per call, not cached with the check — a reload after "Not now" must not
  // bring the dialog back.
  handle('checkForUpdate', async () => {
    const info = await updateCheckPromise
    if (!info) return null
    const { dismissedUpdateVersion } = await loadSettings()
    return { ...info, dismissed: info.version === dismissedUpdateVersion }
  })

  return manager
}
