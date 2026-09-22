import { execFile } from 'node:child_process'
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
  const all = networkInterfaces()
  const result: NetworkInterfaceInfo[] = []

  for (const [device, addresses] of Object.entries(all)) {
    if (!addresses) continue
    const ipv4 = addresses.find(
      (addr) => addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')
    )
    if (!ipv4) continue

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
      address: ipv4.address,
      kind,
      mac: ipv4.mac && ipv4.mac !== '00:00:00:00:00:00' ? ipv4.mac : undefined
    })
  }

  return result
}
