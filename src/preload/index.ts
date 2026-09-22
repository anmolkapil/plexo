import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { IpcContract } from '../shared/ipc-contract'
import type { DownloadState, NetworkPreference, ThemeSource } from '../shared/types'

/** Typed wrapper around ipcRenderer.invoke — the channel name picks its args/result shape out of
 * IpcContract, so a call here that doesn't match what registerIpcHandlers (main) actually handles
 * is a compile error instead of a silent runtime mismatch. */
function invoke<K extends keyof IpcContract>(
  channel: K,
  ...args: IpcContract[K]['args']
): Promise<IpcContract[K]['result']> {
  return ipcRenderer.invoke(IpcChannels[channel], ...args)
}

const plexoApi = {
  platform: process.platform,

  listInterfaces: () => invoke('listInterfaces'),
  pingInterfaces: () => invoke('pingInterfaces'),
  deviceBindingSupported: () => invoke('deviceBindingSupported'),
  openNetworkSettings: () => invoke('openNetworkSettings'),
  getNetworkPreferences: () => invoke('getNetworkPreferences'),
  setNetworkPreference: (id: string, patch: NetworkPreference) =>
    invoke('setNetworkPreference', id, patch),
  getThemeSource: () => invoke('getThemeSource'),
  setThemeSource: (source: ThemeSource) => invoke('setThemeSource', source),
  probeUrl: (url: string) => invoke('probeUrl', url),
  getInitialPaths: () => invoke('getInitialPaths'),
  chooseDestinationFolder: (defaultPath: string) => invoke('chooseDestinationFolder', defaultPath),
  chooseSourceFile: () => invoke('chooseSourceFile'),
  readClipboardText: () => invoke('readClipboardText'),
  revealInFolder: (filePath: string) => invoke('revealInFolder', filePath),
  startDownload: (request: IpcContract['startDownload']['args'][0]) =>
    invoke('startDownload', request),
  startSimulatedDownload: (request: IpcContract['startSimulatedDownload']['args'][0]) =>
    invoke('startSimulatedDownload', request),
  getCurrentDownload: () => invoke('getCurrentDownload'),
  pauseDownload: (downloadId: string) => invoke('pauseDownload', downloadId),
  resumeDownload: (downloadId: string) => invoke('resumeDownload', downloadId),
  cancelDownload: (downloadId: string) => invoke('cancelDownload', downloadId),
  removeDownload: (downloadId: string) => invoke('removeDownload', downloadId),
  checkForUpdate: () => invoke('checkForUpdate'),
  dismissUpdate: (version: string) => invoke('dismissUpdate', version),

  onDownloadUpdated: (callback: (state: DownloadState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: DownloadState): void => callback(state)
    ipcRenderer.on(IpcChannels.downloadUpdated, listener)
    return () => ipcRenderer.removeListener(IpcChannels.downloadUpdated, listener)
  },

  onToggleDevToolsPanel: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IpcChannels.toggleDevToolsPanel, listener)
    return () => ipcRenderer.removeListener(IpcChannels.toggleDevToolsPanel, listener)
  }
}

export type PlexoApi = typeof plexoApi

// Nothing in the renderer needs raw Electron/Node access — only the typed plexoApi above is
// exposed. The @electron-toolkit/preload electronAPI (which hands the renderer an unrestricted
// ipcRenderer.invoke/send/on on any channel) is deliberately not bridged.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('plexo', plexoApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.plexo = plexoApi
}
