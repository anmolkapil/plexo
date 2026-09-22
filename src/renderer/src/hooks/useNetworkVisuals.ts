import type { NetworkInterfaceKind } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { assignNetworkColors, resolveNetworkVisual, type NetworkVisual } from '../theme'

export type ResolveNetworkVisual = (
  id: string,
  kind: NetworkInterfaceKind,
  osName: string
) => NetworkVisual

/** Colors are assigned across every known network at once (detected interfaces plus any in the
 * current download), so each screen agrees on which network is which color. */
export function useNetworkVisuals(): ResolveNetworkVisual {
  const interfaces = useAppStore((store) => store.interfaces)
  const chunks = useAppStore((store) => store.currentDownload?.chunks)
  const preferences = useAppStore((store) => store.networkPreferences)

  const networks = new Map<string, NetworkInterfaceKind>()
  for (const iface of interfaces) networks.set(iface.id, iface.kind)
  for (const chunk of chunks ?? []) {
    if (!networks.has(chunk.interfaceId)) networks.set(chunk.interfaceId, chunk.interfaceKind)
  }
  const colors = assignNetworkColors(networks, preferences)

  return (id, kind, osName) =>
    resolveNetworkVisual(kind, osName, preferences[id], colors.get(id) ?? 'teal')
}
