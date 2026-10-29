import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, readlink, realpath } from 'node:fs/promises'
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

interface LinuxAdapter {
  displayName: string
  kind: NetworkInterfaceKind
  /** The USB serial of the device behind a USB network adapter, such as a tethered phone. */
  usbSerial?: string
}

/** A phone shared over USB gets a random MAC each time it's plugged in, and so a new enx… name
 * that matches nothing saved for it. The serial its USB device reports doesn't change: the network
 * function is …/usb1/1-2/1-2:1.0, and its parent, 1-2, is the phone. */
async function readUsbSerial(sysPath: string): Promise<string | undefined> {
  try {
    const usbDevice = await realpath(`${sysPath}/device/..`)
    if (!usbDevice.includes('/usb')) return undefined
    return (await readFile(`${usbDevice}/serial`, 'utf8')).trim() || undefined
  } catch {
    return undefined
  }
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
    // Each block is "Hardware Port: Wi-Fi", "Device: en0", "Ethernet Address: …", always in that
    // order. Read by position, not by label: a Mac in another language translates the labels
    // ("Matériel") as well as the names ("WLAN"), and matching English found nothing there.
    for (const block of stdout.split(/\n\s*\n/)) {
      const [port, device] = block
        .split('\n')
        .filter((line) => line.includes(':'))
        .map((line) => line.slice(line.indexOf(':') + 1).trim())
      // A BSD device name (en0, bridge0) is how a real block is told from the trailing VLAN list.
      if (port && device && /^[a-z]+\d+$/.test(device)) deviceToName.set(device, port)
    }
  } catch {
    // networksetup missing or failed — callers fall back to raw device names.
  }
  return deviceToName
}

/** Linux names a device by what it is, in systemd's predictable names (wlp2s0, enp3s0,
 * enp0s20f0u1, enx3a5b0c1d2e4f) or the older ones (wlan0, eth0, usb0): wl is Wi-Fi; a USB port in
 * the path (…u1), a MAC-based name (enx) or usb is a USB adapter, which a tethered phone is; en and
 * eth are Ethernet. There's no name lookup to read instead, as macOS and Windows have. */
function classifyLinuxDevice(device: string): NetworkInterfaceKind {
  if (/^wl/.test(device)) return 'wifi'
  if (/^usb|^enx|^en\w*u\d/.test(device)) return 'usb'
  if (/^(en|eth)/.test(device)) return 'ethernet'
  if (/^(br|virbr)/.test(device)) return 'bridge'
  return 'other'
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

/** Adapter aliases ("Wi-Fi", "Ethernet 2") match Node's interface names, and are what Windows shows
 * people; the description ("Intel(R) Wi-Fi 6 AX201 160MHz") and physical medium only tell what kind
 * of network a renamed or localized adapter is. */
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

      const usbSerial = kind === 'usb' ? await readUsbSerial(sysPath) : undefined
      adapters.set(device, { displayName, kind, usbSerial })
    })
  )

  // Ids must be unique: a serial two devices share (cheap phones that all report
  // 0123456789ABCDEF, or one phone with two network functions) names neither of them.
  const serials = [...adapters.values()].flatMap((adapter) =>
    adapter.usbSerial ? [adapter.usbSerial] : []
  )
  const shared = new Set(serials.filter((serial, i) => serials.indexOf(serial) !== i))
  for (const adapter of adapters.values()) {
    if (adapter.usbSerial && shared.has(adapter.usbSerial)) delete adapter.usbSerial
  }

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

/** What the OS calls each device, looked up again only when the set of devices changes: it
 * takes a child process, while the addresses themselves are one cheap system call. */
let labels: {
  devices: string
  lookup: Promise<[Map<string, string>, Map<string, WindowsAdapter>, Map<string, LinuxAdapter>]>
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
    labels = {
      devices,
      lookup: Promise.all([getMacHardwarePortNames(), getWindowsAdapters(), getLinuxAdapters()])
    }
  }
  const [hardwarePorts, windowsAdapters, linuxAdapters] = await labels.lookup
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

    // On Linux, skip internal/virtual bridge adapters that aren't recognized hardware/adapters
    if (process.platform === 'linux' && linuxAdapters.size > 0 && !linuxAdapters.has(device)) {
      continue
    }

    const hardwareName = hardwarePorts.get(device)
    const adapter = windowsAdapters.get(device)
    const linuxAdapter = linuxAdapters.get(device)

    let kind =
      linuxAdapter?.kind ??
      (process.platform === 'linux'
        ? classifyLinuxDevice(device)
        : classifyInterface(adapter?.InterfaceDescription ?? hardwareName ?? device))
    // NDIS media: 1 = wireless LAN, 9 = native 802.11, 14 = Ethernet (802.3).
    if (adapter?.NdisPhysicalMedium === 1 || adapter?.NdisPhysicalMedium === 9) kind = 'wifi'
    else if (kind === 'other' && adapter?.NdisPhysicalMedium === 14) kind = 'ethernet'

    const displayName = linuxAdapter?.displayName ?? hardwareName ?? device

    result.push({
      // A tethered phone keeps its saved name and color across replugs (see readUsbSerial).
      id: linuxAdapter?.usbSerial ? `usb:${linuxAdapter.usbSerial}` : device,
      device,
      displayName,
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
