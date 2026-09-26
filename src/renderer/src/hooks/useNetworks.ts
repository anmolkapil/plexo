import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

const LATENCY_POLL_MS = 5000

/** Keeps the network list current for the lifetime of the app: the main process watches the
 * networks and says whenever one comes, goes or changes. */
export function useNetworkEvents(): void {
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const receiveInterfaces = useAppStore((store) => store.receiveInterfaces)

  useEffect(() => {
    const unsubscribe = window.plexo.onNetworksChanged(receiveInterfaces)
    void loadInterfaces()
    return unsubscribe
  }, [loadInterfaces, receiveInterfaces])
}

/** Keeps each network's latency readout fresh while a screen that shows it is mounted. */
export function useLatencyPolling(): void {
  const refreshLatencies = useAppStore((store) => store.refreshLatencies)

  useEffect(() => {
    void refreshLatencies()
    const interval = setInterval(refreshLatencies, LATENCY_POLL_MS)
    return () => clearInterval(interval)
  }, [refreshLatencies])
}
