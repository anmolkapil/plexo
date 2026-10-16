import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  NetworkDoctorIssue,
  NetworkDoctorReport,
  NetworkInterfaceInfo
} from '../../shared/types'

const execFileAsync = promisify(execFile)
const POWERSHELL_TIMEOUT_MS = 5000

export function computeIpv4Subnet(address: string, netmask?: string): string | null {
  if (!netmask) return null
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

export interface RawNetAdapter {
  Name?: string
  InterfaceDescription?: string
  InterfaceIndex?: number
  Status?: string
  LinkSpeed?: string
  Virtual?: boolean
  NdisPhysicalMedium?: number
}

export interface RawNetIPInterface {
  InterfaceAlias?: string
  InterfaceIndex?: number
  InterfaceMetric?: number
  AutomaticMetric?: number | boolean
  Dhcp?: number | boolean
  ConnectionState?: number | string
}

export interface RawNetRoute {
  InterfaceAlias?: string
  InterfaceIndex?: number
  NextHop?: string
  RouteMetric?: number
}

export interface RawNetConnectionProfile {
  InterfaceAlias?: string
  InterfaceIndex?: number
  Name?: string
  NetworkCategory?: number
  IPv4Connectivity?: number
}

export interface RawPowerShellDoctorData {
  adapters?: RawNetAdapter[]
  ipInterfaces?: RawNetIPInterface[]
  routes?: RawNetRoute[]
  profiles?: RawNetConnectionProfile[]
  domain?: boolean
}

export interface RegMinimizeConnectionsResult {
  exists: boolean
  value?: number
}

function toArray<T>(val: unknown): T[] {
  if (!val) return []
  return Array.isArray(val) ? val : [val as T]
}

/** Parses stdout of `reg.exe query ... /v fMinimizeConnections`. */
export function parseRegQueryMinimizeConnections(stdout: string): RegMinimizeConnectionsResult {
  const match = /\bfMinimizeConnections\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i.exec(stdout)
  if (!match) return { exists: false }
  const raw = match[1]
  const value = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
  return { exists: !Number.isNaN(value), value: Number.isNaN(value) ? undefined : value }
}

/** Parses JSON output of the combined PowerShell network query. */
export function parsePowerShellDoctorData(jsonString: string): RawPowerShellDoctorData {
  const clean = jsonString.trim().replace(/^\uFEFF/, '')
  if (!clean) return { adapters: [], ipInterfaces: [], routes: [], profiles: [], domain: false }
  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>
    return {
      adapters: toArray<RawNetAdapter>(parsed.adapters),
      ipInterfaces: toArray<RawNetIPInterface>(parsed.ipInterfaces),
      routes: toArray<RawNetRoute>(parsed.routes),
      profiles: toArray<RawNetConnectionProfile>(parsed.profiles),
      domain: Boolean(parsed.domain)
    }
  } catch {
    return { adapters: [], ipInterfaces: [], routes: [], profiles: [], domain: false }
  }
}

const VIRTUAL_REGEX =
  /hyper-v|virtual|wsl|vethernet|tap|vpn|tailscale|wireguard|wintun|zerotier|openvpn/i

/**
 * Pure evaluator that inspects parsed Windows network state and active interfaces,
 * emitting structured diagnostic issues and recommendations.
 */
export function diagnoseWindowsNetwork({
  psData,
  regData,
  interfaces
}: {
  psData: RawPowerShellDoctorData
  regData: RegMinimizeConnectionsResult
  interfaces: NetworkInterfaceInfo[]
}): NetworkDoctorReport {
  const issues: NetworkDoctorIssue[] = []
  const adapters = psData.adapters ?? []
  const ipInterfaces = psData.ipInterfaces ?? []
  const routes = psData.routes ?? []
  const isDomain = Boolean(psData.domain)

  // 1. Check fMinimizeConnections policy
  if (regData.exists && (regData.value ?? 0) !== 0) {
    const domainNote = isDomain
      ? ' Note: This computer is domain-joined and this policy may be managed by your organization.'
      : ''
    issues.push({
      id: 'fMinimizeConnections',
      severity: 'warning',
      title: 'Windows may disconnect Wi-Fi when tethering is connected',
      detail:
        `Windows policy "fMinimizeConnections" is active (value: ${regData.value}). ` +
        `This policy causes Windows to minimize simultaneous connections, which often forces Wi-Fi offline ` +
        `when an Ethernet or USB phone tether connection becomes active.${domainNote}`,
      recommendation:
        'To allow multiple simultaneous connections:\n' +
        '• Windows Pro/Enterprise: Open gpedit.msc → Computer Configuration → Administrative Templates → Network → Windows Connection Manager → disable "Minimize the number of simultaneous connections..."\n' +
        '• Windows Home: Run in an elevated prompt:\n' +
        '  reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy" /v fMinimizeConnections /t REG_DWORD /d 0 /f\n' +
        '  (Then restart your computer or reconnect network adapters).'
    })
  } else if (!regData.exists) {
    const domainNote = isDomain
      ? ' Note: This computer is domain-joined and settings may be managed by your organization.'
      : ''
    issues.push({
      id: 'fMinimizeConnections',
      severity: 'info',
      title: 'Simultaneous connection policy is unconfigured (default)',
      detail:
        `The "fMinimizeConnections" policy is not explicitly set in the registry. By default, Windows Connection Manager ` +
        `may still disconnect Wi-Fi when a wired or mobile tether adapter is connected.${domainNote}`,
      recommendation:
        'If Wi-Fi drops when you plug in your phone tether, set fMinimizeConnections to 0:\n' +
        '  reg add "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy" /v fMinimizeConnections /t REG_DWORD /d 0 /f'
    })
  }

  // 2. Identify default route owner and metrics
  // In Windows, default route has DestinationPrefix 0.0.0.0/0.
  // Effective total metric is RouteMetric + InterfaceMetric.
  const ipInterfaceByAlias = new Map<string, RawNetIPInterface>()
  const ipInterfaceByIndex = new Map<number, RawNetIPInterface>()
  for (const ipIf of ipInterfaces) {
    if (ipIf.InterfaceAlias) ipInterfaceByAlias.set(ipIf.InterfaceAlias, ipIf)
    if (typeof ipIf.InterfaceIndex === 'number') ipInterfaceByIndex.set(ipIf.InterfaceIndex, ipIf)
  }

  const adapterByAlias = new Map<string, RawNetAdapter>()
  const adapterByIndex = new Map<number, RawNetAdapter>()
  for (const ad of adapters) {
    if (ad.Name) adapterByAlias.set(ad.Name, ad)
    if (typeof ad.InterfaceIndex === 'number') adapterByIndex.set(ad.InterfaceIndex, ad)
  }

  interface EvaluatedRoute {
    alias: string
    index?: number
    nextHop?: string
    routeMetric: number
    interfaceMetric: number
    totalMetric: number
    adapter?: RawNetAdapter
  }

  const evaluatedRoutes: EvaluatedRoute[] = []
  for (const route of routes) {
    const alias = route.InterfaceAlias || ''
    const index = route.InterfaceIndex
    const ipIf =
      (index !== undefined ? ipInterfaceByIndex.get(index) : undefined) ??
      ipInterfaceByAlias.get(alias)
    const ad =
      (index !== undefined ? adapterByIndex.get(index) : undefined) ?? adapterByAlias.get(alias)
    const routeMetric = route.RouteMetric ?? 0
    const interfaceMetric = ipIf?.InterfaceMetric ?? 0
    evaluatedRoutes.push({
      alias,
      index,
      nextHop: route.NextHop,
      routeMetric,
      interfaceMetric,
      totalMetric: routeMetric + interfaceMetric,
      adapter: ad
    })
  }

  evaluatedRoutes.sort((a, b) => a.totalMetric - b.totalMetric)
  const defaultRoute = evaluatedRoutes[0]
  let defaultRouteOwner: NetworkDoctorReport['defaultRouteOwner'] = undefined

  if (defaultRoute) {
    defaultRouteOwner = {
      interfaceName: defaultRoute.alias || defaultRoute.adapter?.Name || 'Unknown',
      metric: defaultRoute.totalMetric,
      nextHop: defaultRoute.nextHop
    }

    // Check if non-Wi-Fi (such as tether or Ethernet) has a lower metric than an active Wi-Fi
    const isOwnerWifi =
      defaultRoute.adapter?.NdisPhysicalMedium === 9 ||
      defaultRoute.adapter?.NdisPhysicalMedium === 1 ||
      /wi-?fi|wireless|wlan/i.test(defaultRoute.alias)

    const wifiRoute = evaluatedRoutes.find(
      (r) =>
        r.adapter?.NdisPhysicalMedium === 9 ||
        r.adapter?.NdisPhysicalMedium === 1 ||
        /wi-?fi|wireless|wlan/i.test(r.alias)
    )

    if (!isOwnerWifi && wifiRoute && defaultRoute.totalMetric < wifiRoute.totalMetric) {
      issues.push({
        id: 'defaultRoute',
        severity: 'info',
        title: `Default internet route owned by ${defaultRoute.alias} (metric: ${defaultRoute.totalMetric})`,
        detail:
          `Windows sends unpinned default traffic (such as system updates and web browsing) through ` +
          `"${defaultRoute.alias}" because its metric (${defaultRoute.totalMetric}) is lower than Wi-Fi ` +
          `(${wifiRoute.alias}: metric ${wifiRoute.totalMetric}). If this adapter is a cellular phone tether, ` +
          `non-Plexo apps will consume cellular data by default.`,
        recommendation:
          defaultRoute.index !== undefined
            ? `To prioritize Wi-Fi for general traffic while still combining both in Plexo, set the tether metric higher in an elevated PowerShell:\n` +
              `  Set-NetIPInterface -InterfaceIndex ${defaultRoute.index} -AutomaticMetric Disabled -InterfaceMetric 500`
            : undefined,
        interfaceName: defaultRoute.alias
      })
    }
  }

  // 3. Detect IPv4 subnet overlaps between distinct active interfaces
  for (let i = 0; i < interfaces.length; i++) {
    for (let j = i + 1; j < interfaces.length; j++) {
      const a = interfaces[i]
      const b = interfaces[j]
      const aSubnets = a.addresses
        .filter((addr) => addr.family === 4 && addr.subnet)
        .map((addr) => addr.subnet!)
      const bSubnets = b.addresses
        .filter((addr) => addr.family === 4 && addr.subnet)
        .map((addr) => addr.subnet!)
      const common = aSubnets.find((sub) => bSubnets.includes(sub))
      if (common) {
        issues.push({
          id: 'subnetOverlap',
          severity: 'warning',
          title: `Subnet overlap: "${a.displayName}" and "${b.displayName}"`,
          detail:
            `Both "${a.displayName}" and "${b.displayName}" are assigned IP addresses in the same subnet (${common}). ` +
            `This happens when a phone tether and local Wi-Fi router share identical private subnet ranges (e.g. 192.168.1.0/24). ` +
            `The Windows routing table cannot reliably disambiguate local gateway destinations between them.`,
          recommendation:
            'Change your local Wi-Fi router or phone hotspot settings so that each connection operates on a distinct IP subnet range.'
        })
      }
    }
  }

  // 4. APIPA and no-gateway adapters
  for (const iface of interfaces) {
    const hasApipa = iface.addresses.some((addr) => addr.address.startsWith('169.254.'))
    if (hasApipa) {
      issues.push({
        id: 'apipa',
        severity: 'warning',
        title: `APIPA self-assigned IP on "${iface.displayName}"`,
        detail: `Adapter "${iface.displayName}" has an APIPA address (169.254.x.x) and cannot communicate with the internet.`,
        recommendation:
          'Check cable connection or DHCP router configuration. This adapter should remain unselected in Plexo.',
        interfaceName: iface.displayName
      })
    }

    // Check if this interface has any route in the routing table
    const hasDefaultRoute = evaluatedRoutes.some(
      (r) =>
        r.alias === iface.displayName ||
        r.alias === iface.device ||
        (typeof r.index === 'number' &&
          (adapterByIndex.get(r.index)?.Name === iface.displayName ||
            adapterByIndex.get(r.index)?.Name === iface.device))
    )

    if (!hasDefaultRoute && !hasApipa && iface.addresses.some((addr) => addr.family === 4)) {
      issues.push({
        id: 'noGateway',
        severity: 'warning',
        title: `No default gateway on "${iface.displayName}"`,
        detail:
          `Adapter "${iface.displayName}" has an IP address but no default route (0.0.0.0/0) to the internet. ` +
          `Plexo cannot route downloads through this adapter alone.`,
        recommendation:
          'Ensure this network adapter is connected to a router with internet access, or leave it unselected in Plexo.',
        interfaceName: iface.displayName
      })
    }
  }

  // 5. Virtual / VPN / Hyper-V / WSL adapters
  for (const ad of adapters) {
    if (ad.Status && ad.Status.toLowerCase() !== 'up') continue
    const isVirtual =
      ad.Virtual === true ||
      VIRTUAL_REGEX.test((ad.InterfaceDescription || '') + ' ' + (ad.Name || ''))
    if (isVirtual && ad.Name) {
      issues.push({
        id: 'virtualAdapter',
        severity: 'info',
        title: `Virtual or VPN adapter: "${ad.Name}"`,
        detail:
          `Adapter "${ad.Name}" (${ad.InterfaceDescription || 'Virtual'}) is a tunnel or virtual network. ` +
          `Virtual adapters route through existing physical interfaces and do not provide an independent internet uplink.`,
        recommendation:
          'Keep this adapter unselected in Plexo to avoid duplicating traffic across the same physical connection.',
        interfaceName: ad.Name
      })
    }
  }

  return {
    timestamp: Date.now(),
    supported: true,
    partOfDomain: isDomain,
    defaultRouteOwner,
    issues
  }
}

// Module-level cache: only re-runs PowerShell when interface list changes
let cachedKey = ''
let cachedReport: NetworkDoctorReport | null = null
let inFlightScan: Promise<NetworkDoctorReport> | null = null

async function runWindowsDoctor(interfaces: NetworkInterfaceInfo[]): Promise<NetworkDoctorReport> {
  if (process.platform !== 'win32') {
    return { timestamp: Date.now(), supported: false, issues: [] }
  }

  // Run reg.exe query for fMinimizeConnections (does not require admin rights)
  let regData: RegMinimizeConnectionsResult = { exists: false }
  try {
    const { stdout } = await execFileAsync(
      'reg.exe',
      [
        'query',
        'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy',
        '/v',
        'fMinimizeConnections'
      ],
      { timeout: 3000, encoding: 'utf8' }
    )
    regData = parseRegQueryMinimizeConnections(stdout)
  } catch {
    // Exit code 1 means key or value does not exist
    regData = { exists: false }
  }

  // Run PowerShell cmdlets with ConvertTo-Json
  let psData: RawPowerShellDoctorData = {}
  try {
    const psScript =
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
      '@{ ' +
      'adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue | Select-Object Name, InterfaceDescription, InterfaceIndex, Status, LinkSpeed, Virtual, NdisPhysicalMedium); ' +
      'ipInterfaces = @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, InterfaceIndex, InterfaceMetric, AutomaticMetric, Dhcp, ConnectionState); ' +
      'routes = @(Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, InterfaceIndex, NextHop, RouteMetric); ' +
      'profiles = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, InterfaceIndex, Name, NetworkCategory, IPv4Connectivity); ' +
      'domain = [bool]((Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).PartOfDomain) ' +
      '} | ConvertTo-Json -Depth 3 -Compress'

    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, encoding: 'utf8' }
    )
    psData = parsePowerShellDoctorData(stdout)
  } catch (error) {
    console.warn('[plexo] Network Doctor PowerShell query failed:', error)
  }

  return diagnoseWindowsNetwork({ psData, regData, interfaces })
}

/**
 * Returns the Network Doctor report.
 * Guaranteed not to run PowerShell on a timer: it only re-queries Windows
 * when the interface list changes, or when explicitly forced by user action.
 */
export async function getWindowsDoctorReport(
  interfaces: NetworkInterfaceInfo[],
  force = false
): Promise<NetworkDoctorReport> {
  if (process.platform !== 'win32') {
    return { timestamp: Date.now(), supported: false, issues: [] }
  }

  const key = interfaces
    .map(
      (i) =>
        `${i.id}:${i.addresses
          .map((a) => a.address)
          .sort()
          .join(',')}`
    )
    .sort()
    .join('\n')

  if (!force && cachedReport && cachedKey === key) {
    return cachedReport
  }

  if (inFlightScan) return inFlightScan

  inFlightScan = runWindowsDoctor(interfaces)
    .then((report) => {
      cachedKey = key
      cachedReport = report
      inFlightScan = null
      return report
    })
    .catch((err) => {
      inFlightScan = null
      throw err
    })

  return inFlightScan
}
