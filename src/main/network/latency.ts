import type { NetworkInterfaceInfo } from '../../shared/types'
import { connectFrom } from './deviceBinding'

const PROBE_HOSTS = ['1.1.1.1', '8.8.8.8']
const PROBE_PORT = 443
const TIMEOUT_MS = 2000

/** Rough per-interface latency: time to open a TCP connection to a reliable
 * host, sourced from that interface's local address. null means unreachable. */
function measureLatencyToHost(localAddress: string, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = connectFrom(localAddress, host, PROBE_PORT)
    let settled = false

    const finish = (result: number | null): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(TIMEOUT_MS)
    socket.once('connect', () => finish(Date.now() - start))
    socket.once('timeout', () => finish(null))
    socket.once('error', () => finish(null))
  })
}

async function measureLatency(localAddress: string): Promise<number | null> {
  for (const host of PROBE_HOSTS) {
    const latency = await measureLatencyToHost(localAddress, host)
    if (latency !== null) return latency
  }
  return null
}

export async function measureLatencies(
  interfaces: NetworkInterfaceInfo[]
): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    interfaces.map(async (iface) => [iface.id, await measureLatency(iface.address)] as const)
  )
  return Object.fromEntries(entries)
}
