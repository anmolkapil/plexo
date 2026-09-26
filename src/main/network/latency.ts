import type { IpFamily, NetworkInterfaceInfo } from '../../shared/types'
import { connectRoute } from './deviceBinding'

const PROBE_HOSTS: { address: string; family: IpFamily }[][] = [
  [
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 }
  ],
  [
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 }
  ]
]
const PROBE_PORT = 443
const TIMEOUT_MS = 2000

/** Rough per-interface latency: time to open a TCP connection to a reliable
 * host, sourced from that interface's local address. null means unreachable. */
function measureLatencyToHost(
  iface: NetworkInterfaceInfo,
  localAddress: string,
  remoteAddress: string,
  family: IpFamily
): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = connectRoute(
      { device: iface.device, localAddress, remoteAddress, family },
      PROBE_PORT
    )
    let settled = false

    const finish = (result: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), TIMEOUT_MS)
    socket.once('connect', () => finish(Date.now() - start))
    socket.once('error', () => finish(null))
  })
}

async function measureLatency(iface: NetworkInterfaceInfo): Promise<number | null> {
  for (const hosts of PROBE_HOSTS) {
    const attempts = hosts.flatMap((host) =>
      iface.addresses
        .filter((local) => local.family === host.family)
        .map((local) => measureLatencyToHost(iface, local.address, host.address, host.family))
    )
    const latencies = (await Promise.all(attempts)).filter(
      (latency): latency is number => latency !== null
    )
    if (latencies.length > 0) return Math.min(...latencies)
  }
  return null
}

export async function measureLatencies(
  interfaces: NetworkInterfaceInfo[]
): Promise<Record<string, number | null>> {
  const entries = await Promise.all(
    interfaces.map(async (iface) => [iface.id, await measureLatency(iface)] as const)
  )
  return Object.fromEntries(entries)
}
