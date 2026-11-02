import type { Socks5Settings } from '@shared/types'
import { create } from 'zustand'

interface Socks5Store {
  /** Persisted in the main process, which spreads downloads' connections over its hosts. */
  settings: Socks5Settings
  /** Saves `settings`; the store changes first, and goes back if the save fails. */
  save: (settings: Socks5Settings) => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
}

export const useSocks5Store = create<Socks5Store>((set, get) => ({
  settings: window.plexo.initialState.socks5 ?? { enabled: false, hosts: [] },

  save: async (settings) => {
    const previous = get().settings
    set({ settings })
    try {
      await window.plexo.updateSettings({ socks5: settings })
    } catch (error) {
      set({ settings: previous })
      throw error
    }
  },

  setEnabled: (enabled) => get().save({ ...get().settings, enabled })
}))

/** Hosts that would carry connections: switched on, with an address. */
export function usableHostCount(settings: Socks5Settings): number {
  return settings.hosts.filter((host) => host.enabled && host.host.trim().length > 0).length
}
