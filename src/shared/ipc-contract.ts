import type {
  DownloadState,
  InitialPaths,
  NetworkInterfaceInfo,
  NetworkPreference,
  NetworkPreferences,
  ProbeResult,
  StartDownloadRequest,
  StartSimulatedDownloadRequest,
  ThemeSource,
  UpdateInfo
} from './types'

/** The request/response half of the IPC surface (every IpcChannels entry except the two
 * main->renderer push events, downloadUpdated and toggleDevToolsPanel) — one source of truth for
 * both plexoApi (preload) and registerIpcHandlers (main), so a signature drift between the two
 * is a compile error instead of a runtime one. */
export interface IpcContract {
  listInterfaces: { args: []; result: NetworkInterfaceInfo[] }
  pingInterfaces: { args: []; result: Record<string, number | null> }
  deviceBindingSupported: { args: []; result: boolean }
  openNetworkSettings: { args: []; result: void }
  getNetworkPreferences: { args: []; result: NetworkPreferences }
  setNetworkPreference: {
    args: [id: string, patch: NetworkPreference]
    result: NetworkPreferences
  }
  getThemeSource: { args: []; result: ThemeSource }
  setThemeSource: { args: [source: ThemeSource]; result: ThemeSource }
  probeUrl: { args: [url: string, headers?: Record<string, string>]; result: ProbeResult }
  getInitialPaths: { args: []; result: InitialPaths }
  chooseDestinationFolder: { args: [defaultPath: string]; result: string | null }
  chooseSourceFile: { args: []; result: string | null }
  readClipboardText: { args: []; result: string }
  revealInFolder: { args: [filePath: string]; result: void }
  startDownload: { args: [request: StartDownloadRequest]; result: string }
  startSimulatedDownload: { args: [request: StartSimulatedDownloadRequest]; result: string }
  getCurrentDownload: { args: []; result: DownloadState | null }
  pauseDownload: { args: [id: string]; result: void }
  resumeDownload: { args: [id: string]; result: void }
  cancelDownload: { args: [id: string]; result: void }
  removeDownload: { args: [id: string]; result: void }
  checkForUpdate: { args: []; result: UpdateInfo | null }
  dismissUpdate: { args: [version: string]; result: void }
}
