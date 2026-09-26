import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import type { NetworkAddress, NetworkInterfaceInfo, NetworkInterfaceKind } from '../../shared/types'
import { testInterfaces } from '../testKnobs'

const execFileAsync = promisify(execFile)
const DISCOVERY_TIMEOUT_MS = 5000

interface WindowsAdapter {
  Name: string
  InterfaceDescription: string
  NdisPhysicalMedium: number
}

/**
 * macOS device names (en0, en1, ...) don't say what they are. `networksetup`
 * knows the human-readable "Hardware Port" for each device (Wi-Fi, iPhone USB,
 * Thunderbolt Bridge, ...), which is what lets us label a USB-tethered phone
 * as such instead of just "en6".
 */
async function getMacHardwarePortNames(): Promise<Map<string, string>> {
  const deviceToName = new Map<string, string>()
  if (process.platform !== 'darwin') return deviceToName
  try {
    const { stdout } = await execFileAsync('networksetup', ['-listallhardwareports'], {
      timeout: DISCOVERY_TIMEOUT_MS
    })
    const blocks = stdout.split(/\n\s*\n/)
    for (const block of blocks) {
      const portMatch = /Hardware Port:\s*(.+)/.exec(block)
      const deviceMatch = /Device:\s*(.+)/.exec(block)
      if (portMatch && deviceMatch) {
        deviceToName.set(deviceMatch[1].trim(), portMatch[1].trim())
      }
    }
  } catch {
    // networksetup missing or failed — callers fall back to raw device names.
  }
  return deviceToName
}

function classifyInterface(hardwarePortName: string): NetworkInterfaceKind {
  const name = hardwarePortName.toLowerCase()
  if (/wi-?fi|wireless|wlan|802\.11|airport/.test(name)) return 'wifi'
  if (/rndis|remote ndis|tether|apple mobile device/.test(name)) return 'usb'
  if (name.includes('iphone') || name.includes('ipad') || name.includes('usb')) return 'usb'
  if (name.includes('bridge')) return 'bridge'
  if (name.includes('ethernet') || name.includes('lan')) return 'ethernet'
  return 'other'
}

/** Adapter aliases match Node's interface names; metadata identifies renamed or localized adapters. */
async function getWindowsAdapters(): Promise<Map<string, WindowsAdapter>> {
  if (process.platform !== 'win32') return new Map()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-NetAdapter -ErrorAction Stop | Select-Object Name, InterfaceDescription, NdisPhysicalMedium | ConvertTo-Json -Compress'
      ],
      { windowsHide: true, timeout: DISCOVERY_TIMEOUT_MS, encoding: 'utf8' }
    )
    const parsed = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
    const adapters: WindowsAdapter[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return new Map(
      adapters
        .filter((adapter) => typeof adapter.Name === 'string')
        .map((adapter) => [adapter.Name, adapter])
    )
  } catch {
    // Restricted PowerShell or unavailable metadata must not prevent downloads.
    return new Map()
  }
}

/** Computes the CIDR subnet (e.g. "192.168.1.0/24") from an IPv4 address and netmask. */
export function ipv4Subnet(address: string, netmask: string): string | null {
  const ipParts = address.split('.').map(Number)
  const maskParts = netmask.split('.').map(Number)
  if (ipParts.length !== 4 || maskParts.length !== 4) return null
  if (
    ipParts.some((p) => isNaN(p) || p < 0 || p > 255) ||
    maskParts.some((p) => isNaN(p) || p < 0 || p > 255)
  ) {
    return null
  }
  const subnetParts = ipParts.map((part, i) => part & maskParts[i])
  const maskBits =
    maskParts
      .map((b) => b.toString(2).padStart(8, '0'))
      .join('')
      .split('1').length - 1
  return `${subnetParts.join('.')}/${maskBits}`
}

/** What the OS calls each device, looked up again only when the set of devices changes: it
 * takes a child process, while the addresses themselves are one cheap system call. */
let labels: {
  devices: string
  lookup: Promise<[Map<string, string>, Map<string, WindowsAdapter>]>
} | null = null

/**
 * Active non-loopback interfaces, with every usable local address on each device.
 */
export async function listActiveInterfaces(): Promise<NetworkInterfaceInfo[]> {
  const overridden = testInterfaces()
  if (overridden) return overridden

  const all = networkInterfaces()
  const devices = Object.keys(all).sort().join('\n')
  if (labels?.devices !== devices) {
    labels = { devices, lookup: Promise.all([getMacHardwarePortNames(), getWindowsAdapters()]) }
  }
  const [hardwarePorts, windowsAdapters] = await labels.lookup
  const result: NetworkInterfaceInfo[] = []

  for (const [device, addresses] of Object.entries(all)) {
    if (!addresses) continue
    const usable: NetworkAddress[] = addresses
      .filter(
        (addr) =>
          !addr.internal &&
          (addr.family === 'IPv4' || addr.family === 'IPv6') &&
          !addr.address.startsWith('169.254.') &&
          !addr.address.toLowerCase().startsWith('fe80:')
      )
      .map((addr) => ({
        address: addr.address,
        family: addr.family === 'IPv6' ? 6 : 4,
        netmask: addr.netmask,
        subnet:
          addr.family === 'IPv4' && addr.netmask
            ? (ipv4Subnet(addr.address, addr.netmask) ?? undefined)
            : undefined
      }))
    if (usable.length === 0) continue

    const hardwareName = hardwarePorts.get(device)
    const adapter = windowsAdapters.get(device)
    let kind = classifyInterface(adapter?.InterfaceDescription ?? hardwareName ?? device)
    // NDIS media: 1 = wireless LAN, 9 = native 802.11, 14 = Ethernet (802.3).
    if (adapter?.NdisPhysicalMedium === 1 || adapter?.NdisPhysicalMedium === 9) kind = 'wifi'
    else if (kind === 'other' && adapter?.NdisPhysicalMedium === 14) kind = 'ethernet'
    result.push({
      id: device,
      device,
      displayName: hardwareName ?? adapter?.InterfaceDescription ?? device,
      addresses: usable,
      kind,
      mac: addresses.find((addr) => addr.mac && addr.mac !== '00:00:00:00:00:00')?.mac
    })
  }

  return result
}

const POLL_MS = 1000

/**
 * The computer's networks, kept current: nothing tells a process when a network appears, drops
 * or gets a new address, so it looks every second. `onChange` hears of every change.
 */
export class NetworkMonitor {
  private list: NetworkInterfaceInfo[] | null = null
  private polling: Promise<NetworkInterfaceInfo[]> = Promise.resolve([])

  constructor(private readonly onChange: (networks: NetworkInterfaceInfo[]) => void) {
    void this.refresh()
    setInterval(() => void this.refresh(), POLL_MS).unref()
  }

  /** Null until the first look has finished. */
  get current(): NetworkInterfaceInfo[] | null {
    return this.list
  }

  find(id: string): NetworkInterfaceInfo | undefined {
    return this.list?.find((iface) => iface.id === id)
  }

  /** Looks now, rather than at the next poll. Looks run one at a time, so the last word is
   * always the newest. */
  refresh(): Promise<NetworkInterfaceInfo[]> {
    this.polling = this.polling
      .catch(() => [])
      .then(async () => {
        const next = await listActiveInterfaces().catch(() => this.list ?? [])
        if (JSON.stringify(next) !== JSON.stringify(this.list)) {
          this.list = next
          this.onChange(next)
        }
        return next
      })
    return this.polling
  }
}
