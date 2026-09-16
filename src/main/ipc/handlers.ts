import { clipboard, dialog, ipcMain, nativeTheme, shell, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  NetworkInterfaceInfo,
  NetworkPreference,
  StartDownloadRequest,
  ThemeSource
} from '../../shared/types'
import { DownloadManager } from '../download/downloadManager'
import { getDefaultDownloadsDir, getHomeDir } from '../download/paths'
import { probeSource } from '../download/sourceProbe'
import { measureLatencies } from '../network/latency'
import { listActiveInterfaces } from '../network/interfaces'
import { loadNetworkPreferences, saveNetworkPreference } from '../network/preferences'
import { saveThemeSource } from '../settings'

const NETWORK_SETTINGS_URL =
  process.platform === 'win32'
    ? 'ms-settings:network-status'
    : 'x-apple.systempreferences:com.apple.preference.network'

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

  ipcMain.handle(IpcChannels.listInterfaces, refreshInterfaces)

  ipcMain.handle(IpcChannels.pingInterfaces, async () => measureLatencies(cachedInterfaces))

  ipcMain.handle(IpcChannels.getNetworkPreferences, async () => loadNetworkPreferences())

  ipcMain.handle(
    IpcChannels.setNetworkPreference,
    async (_event, id: string, patch: NetworkPreference) => saveNetworkPreference(id, patch)
  )

  ipcMain.handle(IpcChannels.getThemeSource, async () => nativeTheme.themeSource)

  ipcMain.handle(IpcChannels.setThemeSource, async (_event, source: ThemeSource) => {
    nativeTheme.themeSource = source
    await saveThemeSource(source)
    return nativeTheme.themeSource
  })

  ipcMain.handle(IpcChannels.openNetworkSettings, async () => {
    await shell.openExternal(NETWORK_SETTINGS_URL)
  })

  ipcMain.handle(IpcChannels.probeUrl, async (_event, url: string) => {
    // A magnet link's probe needs somewhere to dial peers from. The renderer polls
    // interfaces continuously, but a probe can still arrive before the first poll lands.
    const interfaces = cachedInterfaces.length > 0 ? cachedInterfaces : await refreshInterfaces()
    return probeSource(url, interfaces)
  })

  ipcMain.handle(IpcChannels.getInitialPaths, async () => ({
    homeDir: getHomeDir(),
    downloadsDir: getDefaultDownloadsDir()
  }))

  ipcMain.handle(IpcChannels.chooseDestinationFolder, async (_event, defaultPath: string) => {
    const window = getWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IpcChannels.readClipboardText, async () => clipboard.readText())

  ipcMain.handle(IpcChannels.revealInFolder, async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(IpcChannels.startDownload, async (_event, request: StartDownloadRequest) =>
    manager.start(request)
  )

  ipcMain.handle(IpcChannels.getCurrentDownload, async () => manager.getCurrentDownload())

  ipcMain.handle(IpcChannels.pauseDownload, async (_event, id: string) => {
    await manager.pause(id)
  })

  ipcMain.handle(IpcChannels.resumeDownload, async (_event, id: string) => {
    manager.resume(id)
  })

  ipcMain.handle(IpcChannels.cancelDownload, async (_event, id: string) => {
    manager.cancel(id)
  })

  ipcMain.handle(IpcChannels.removeDownload, async (_event, id: string) => {
    manager.remove(id)
  })

  return manager
}
