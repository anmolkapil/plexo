import type { NetworkInterfaceKind } from '@shared/types'
import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { assignNetworkColors, resolveNetworkVisual, type NetworkVisual } from '../theme'

export type ResolveNetworkVisual = (
  id: string,
  kind: NetworkInterfaceKind,
  osName: string
) => NetworkVisual

/** Every known network and its kind, as JSON: a string, so a progress update that brings no
 * new network leaves it equal and doesn't re-render whoever asks. */
function knownNetworks(store: ReturnType<typeof useAppStore.getState>): string {
  const networks = new Map<string, NetworkInterfaceKind>()
  for (const iface of store.interfaces) networks.set(iface.id, iface.kind)
  for (const download of Object.values(store.downloads)) {
    for (const network of download.networks) {
      if (!networks.has(network.id)) networks.set(network.id, network.kind)
    }
  }
  for (const download of store.history) {
    for (const network of download.networks) {
      if (!networks.has(network.id)) networks.set(network.id, network.kind)
    }
  }
  return JSON.stringify([...networks])
}

/** Colors are assigned across every known network at once (detected interfaces plus any a
 * download, running or finished, used), so each screen agrees on which network is which color.
 * The function returned stays the same until a network or a preference changes, so it can be
 * handed to memoized rows. */
export function useNetworkVisuals(): ResolveNetworkVisual {
  const known = useAppStore(knownNetworks)
  const preferences = useAppStore((store) => store.networkPreferences)

  return useMemo(() => {
    const networks = new Map<string, NetworkInterfaceKind>(JSON.parse(known))
    const colors = assignNetworkColors(networks, preferences)
    return (id, kind, osName) =>
      resolveNetworkVisual(kind, osName, preferences[id], colors.get(id) ?? 'teal')
  }, [known, preferences])
}
