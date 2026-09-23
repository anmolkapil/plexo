import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { promisify } from 'node:util'
import type { NetworkInterfaceInfo, NetworkInterfaceKind } from '../../shared/types'
import { testInterfaces } from '../testKnobs'

const execFileAsync = promisify(execFile)
const DISCOVERY_TIMEOUT_MS = 5000

interface WindowsAdapter {
  Name: string
  InterfaceDescription: string
  NdisPhysicalMedium: number
}

interface LinuxAdapter {
  displayName: string
  kind: NetworkInterfaceKind
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
  if (/wi-?fi|wireless|wlan|802\.11|airport|^wl/i.test(name)) return 'wifi'
  if (/rndis|remote ndis|tether|apple mobile device|^usb/i.test(name)) return 'usb'
  if (name.includes('iphone') || name.includes('ipad') || name.includes('usb')) return 'usb'
  if (name.includes('bridge') || name.startsWith('br-')) return 'bridge'
  if (/ethernet|lan|^eth|^en/i.test(name)) return 'ethernet'
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

/**
 * Queries Linux sysfs and udev to detect hardware interfaces (PCI, USB, Wi-Fi, Ethernet)
 * and filter out virtual host/container bridges (e.g. docker0, br-*, veth*).
 */
async function getLinuxAdapters(): Promise<Map<string, LinuxAdapter>> {
  const adapters = new Map<string, LinuxAdapter>()
  if (process.platform !== 'linux') return adapters

  let devices: string[]
  try {
    devices = await readdir('/sys/class/net')
  } catch {
    return adapters
  }

  await Promise.all(
    devices.map(async (device) => {
      if (device === 'lo') return
      // Filter out internal container, hypervisor, and dummy bridges/interfaces
      if (/^(docker|br-|veth|virbr|vboxnet|vmnet|cni|flannel|cbr|dummy)/i.test(device)) return

      const sysPath = `/sys/class/net/${device}`
      let isVirtual = false
      try {
        const link = await readlink(sysPath)
        isVirtual = link.includes('/devices/virtual/')
      } catch {
        /* ignore */
      }

      // Pure virtual devices with no hardware backing and no wireless/phy capabilities
      if (
        isVirtual &&
        !existsSync(`${sysPath}/device`) &&
        !existsSync(`${sysPath}/wireless`) &&
        !existsSync(`${sysPath}/phy80211`)
      ) {
        return
      }

      let isWireless =
        existsSync(`${sysPath}/wireless`) ||
        existsSync(`${sysPath}/phy80211`) ||
        /^wl/i.test(device)

      let isUsb = /^usb|^rndis/i.test(device)
      try {
        const link = await readlink(sysPath)
        if (link.includes('/usb')) isUsb = true
      } catch {
        /* ignore */
      }

      let udevModel = ''
      try {
        const { stdout } = await execFileAsync('udevadm', ['info', '-q', 'property', sysPath], {
          timeout: 1000
        })
        for (const line of stdout.split('\n')) {
          if (line.startsWith('ID_BUS=usb')) isUsb = true
          if (line.startsWith('DEVTYPE=wlan')) isWireless = true
          if (line.startsWith('ID_MODEL_FROM_DATABASE=')) {
            udevModel = line.slice('ID_MODEL_FROM_DATABASE='.length).trim()
          }
        }
      } catch {
        /* ignore */
      }

      let kind: NetworkInterfaceKind = 'other'
      if (isWireless) kind = 'wifi'
      else if (isUsb) kind = 'usb'
      else if (/^(eth|en)/i.test(device)) kind = 'ethernet'
      else kind = classifyInterface(device)

      const displayName =
        udevModel ||
        (kind === 'wifi'
          ? 'Wi-Fi'
          : kind === 'ethernet'
            ? 'Ethernet'
            : kind === 'usb'
              ? 'USB Network'
              : device)

      adapters.set(device, { displayName, kind })
    })
  )

  return adapters
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

/**
 * Active non-loopback IPv4 interfaces. Each one has its
 * own local IP, which is what lets us bind a download's outgoing connection
 * to a specific interface (see deviceBinding's `routeFrom`).
 */
export async function listActiveInterfaces(): Promise<NetworkInterfaceInfo[]> {
  const overridden = testInterfaces()
  if (overridden) return overridden

  const hardwarePorts = await getMacHardwarePortNames()
  const windowsAdapters = await getWindowsAdapters()
  const linuxAdapters = await getLinuxAdapters()
  const all = networkInterfaces()
  const result: NetworkInterfaceInfo[] = []

  for (const [device, addresses] of Object.entries(all)) {
    if (!addresses) continue
    const ipv4 = addresses.find(
      (addr) => addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')
    )
    if (!ipv4) continue

    // On Linux, skip internal/virtual bridge adapters that aren't recognized hardware/adapters
    if (process.platform === 'linux' && linuxAdapters.size > 0 && !linuxAdapters.has(device)) {
      continue
    }

    const hardwareName = hardwarePorts.get(device)
    const adapter = windowsAdapters.get(device)
    const linuxAdapter = linuxAdapters.get(device)

    let kind =
      linuxAdapter?.kind ??
      classifyInterface(adapter?.InterfaceDescription ?? hardwareName ?? device)
    // NDIS media: 1 = wireless LAN, 9 = native 802.11, 14 = Ethernet (802.3).
    if (adapter?.NdisPhysicalMedium === 1 || adapter?.NdisPhysicalMedium === 9) kind = 'wifi'
    else if (kind === 'other' && adapter?.NdisPhysicalMedium === 14) kind = 'ethernet'

    const displayName =
      linuxAdapter?.displayName ?? hardwareName ?? adapter?.InterfaceDescription ?? device
    const subnet = ipv4.netmask ? (ipv4Subnet(ipv4.address, ipv4.netmask) ?? undefined) : undefined

    result.push({
      id: device,
      device,
      displayName,
      address: ipv4.address,
      kind,
      mac: ipv4.mac && ipv4.mac !== '00:00:00:00:00:00' ? ipv4.mac : undefined,
      subnet,
      netmask: ipv4.netmask
    })
  }

  return result
}
