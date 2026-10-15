import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyWindowsDoctorFix,
  computeIpv4Subnet,
  diagnoseWindowsNetwork,
  getWindowsDoctorReport,
  parsePowerShellDoctorData,
  parseRegQueryMinimizeConnections,
  type RawPowerShellDoctorData
} from '../src/main/network/windowsDoctor.ts'
import type { NetworkInterfaceInfo } from '../src/shared/types.ts'

// --- 1. Registry Parser Tests ---

test('parseRegQueryMinimizeConnections parses hex 0x1', () => {
  const output = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy
    fMinimizeConnections    REG_DWORD    0x1
`
  const result = parseRegQueryMinimizeConnections(output)
  assert.equal(result.exists, true)
  assert.equal(result.value, 1)
})

test('parseRegQueryMinimizeConnections parses hex 0x0', () => {
  const output = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy
    fMinimizeConnections    REG_DWORD    0x0
`
  const result = parseRegQueryMinimizeConnections(output)
  assert.equal(result.exists, true)
  assert.equal(result.value, 0)
})

test('parseRegQueryMinimizeConnections parses decimal format', () => {
  const output = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy
    fMinimizeConnections    REG_DWORD    1
`
  const result = parseRegQueryMinimizeConnections(output)
  assert.equal(result.exists, true)
  assert.equal(result.value, 1)
})

test('parseRegQueryMinimizeConnections handles not found output', () => {
  const output = 'ERROR: The system was unable to find the specified registry key or value.'
  const result = parseRegQueryMinimizeConnections(output)
  assert.equal(result.exists, false)
  assert.equal(result.value, undefined)
})

test('parseRegQueryMinimizeConnections handles empty string', () => {
  assert.equal(parseRegQueryMinimizeConnections('').exists, false)
})

// --- 2. PowerShell Output Parser Tests (Including Non-English Names) ---

test('parsePowerShellDoctorData parses standard multi-adapter payload', () => {
  const json = JSON.stringify({
    adapters: [
      {
        Name: 'Wi-Fi',
        InterfaceDescription: 'Intel(R) Wi-Fi 7 BE200 320MHz',
        InterfaceIndex: 13,
        Status: 'Up',
        LinkSpeed: '585 Mbps',
        Virtual: false,
        NdisPhysicalMedium: 9
      },
      {
        Name: 'Ethernet',
        InterfaceDescription: 'Intel(R) Ethernet Controller I226-V',
        InterfaceIndex: 9,
        Status: 'Up',
        LinkSpeed: '1 Gbps',
        Virtual: false,
        NdisPhysicalMedium: 14
      }
    ],
    ipInterfaces: [
      {
        InterfaceAlias: 'Wi-Fi',
        InterfaceIndex: 13,
        InterfaceMetric: 35,
        AutomaticMetric: 1
      },
      {
        InterfaceAlias: 'Ethernet',
        InterfaceIndex: 9,
        InterfaceMetric: 25,
        AutomaticMetric: 1
      }
    ],
    routes: [
      {
        InterfaceAlias: 'Ethernet',
        InterfaceIndex: 9,
        NextHop: '192.168.1.1',
        RouteMetric: 0
      }
    ],
    profiles: [
      {
        InterfaceAlias: 'Ethernet',
        InterfaceIndex: 9,
        Name: 'Network 1',
        IPv4Connectivity: 4
      }
    ],
    domain: false
  })

  const parsed = parsePowerShellDoctorData(json)
  assert.equal(parsed.adapters?.length, 2)
  assert.equal(parsed.ipInterfaces?.length, 2)
  assert.equal(parsed.routes?.length, 1)
  assert.equal(parsed.domain, false)
})

test('parsePowerShellDoctorData parses German / French / non-English adapter fixtures', () => {
  const json = JSON.stringify({
    adapters: [
      {
        Name: 'WLAN', // German for Wi-Fi
        InterfaceDescription: 'Intel(R) Dual Band Wireless-AC 8265',
        InterfaceIndex: 12,
        Status: 'Up',
        LinkSpeed: '866 Mbps',
        Virtual: false,
        NdisPhysicalMedium: 9
      },
      {
        Name: 'Connexion au réseau local', // French for LAN
        InterfaceDescription: 'Realtek PCIe GbE Family Controller',
        InterfaceIndex: 4,
        Status: 'Up',
        LinkSpeed: '1 Gbps',
        Virtual: false,
        NdisPhysicalMedium: 14
      },
      {
        Name: 'Conexión compartida (USB)', // Spanish USB tethering
        InterfaceDescription: 'Remote NDIS Compatible Device',
        InterfaceIndex: 18,
        Status: 'Up',
        LinkSpeed: '425 Mbps',
        Virtual: false,
        NdisPhysicalMedium: 0
      }
    ],
    ipInterfaces: [
      { InterfaceAlias: 'WLAN', InterfaceIndex: 12, InterfaceMetric: 30 },
      { InterfaceAlias: 'Connexion au réseau local', InterfaceIndex: 4, InterfaceMetric: 15 },
      { InterfaceAlias: 'Conexión compartida (USB)', InterfaceIndex: 18, InterfaceMetric: 10 }
    ],
    routes: [
      {
        InterfaceAlias: 'Conexión compartida (USB)',
        InterfaceIndex: 18,
        NextHop: '172.20.10.1',
        RouteMetric: 0
      },
      { InterfaceAlias: 'WLAN', InterfaceIndex: 12, NextHop: '192.168.178.1', RouteMetric: 0 }
    ],
    domain: true
  })

  const parsed = parsePowerShellDoctorData(json)
  assert.equal(parsed.adapters?.length, 3)
  assert.equal(parsed.adapters?.[0].Name, 'WLAN')
  assert.equal(parsed.adapters?.[1].Name, 'Connexion au réseau local')
  assert.equal(parsed.adapters?.[2].Name, 'Conexión compartida (USB)')
  assert.equal(parsed.domain, true)
})

test('parsePowerShellDoctorData unwraps single-element objects to arrays', () => {
  // PowerShell ConvertTo-Json emits an object rather than an array when count === 1
  const json = JSON.stringify({
    adapters: {
      Name: 'Wi-Fi',
      InterfaceIndex: 5,
      Status: 'Up'
    },
    ipInterfaces: {
      InterfaceAlias: 'Wi-Fi',
      InterfaceIndex: 5,
      InterfaceMetric: 20
    },
    routes: {
      InterfaceAlias: 'Wi-Fi',
      InterfaceIndex: 5,
      NextHop: '10.0.0.1',
      RouteMetric: 10
    },
    domain: false
  })

  const parsed = parsePowerShellDoctorData(json)
  assert.ok(Array.isArray(parsed.adapters))
  assert.equal(parsed.adapters?.length, 1)
  assert.ok(Array.isArray(parsed.ipInterfaces))
  assert.equal(parsed.ipInterfaces?.length, 1)
  assert.ok(Array.isArray(parsed.routes))
  assert.equal(parsed.routes?.length, 1)
})

// --- 3. Diagnostics Rule Tests ---

test('diagnoseWindowsNetwork flags active fMinimizeConnections with remediation', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [],
    routes: [],
    ipInterfaces: [],
    domain: false
  }
  const regData = { exists: true, value: 1 }
  const interfaces: NetworkInterfaceInfo[] = []

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const issue = report.issues.find((i) => i.id === 'fMinimizeConnections')
  assert.ok(issue, 'Should identify fMinimizeConnections issue')
  assert.equal(issue.severity, 'warning')
  assert.ok(issue.recommendation?.includes('fMinimizeConnections'))
  assert.ok(issue.recommendation?.includes('gpedit.msc'))
})

test('diagnoseWindowsNetwork appends domain notice when computer is domain-joined', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [],
    routes: [],
    ipInterfaces: [],
    domain: true
  }
  const regData = { exists: true, value: 1 }
  const interfaces: NetworkInterfaceInfo[] = []

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const issue = report.issues.find((i) => i.id === 'fMinimizeConnections')
  assert.ok(issue?.detail.includes('domain-joined'))
  assert.equal(report.partOfDomain, true)
})

test('diagnoseWindowsNetwork flags tether beating Wi-Fi on default route metric', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      { Name: 'Wi-Fi', InterfaceIndex: 10, NdisPhysicalMedium: 9, Status: 'Up' },
      {
        Name: 'Mobile Tether',
        InterfaceIndex: 20,
        NdisPhysicalMedium: 0,
        InterfaceDescription: 'Remote NDIS',
        Status: 'Up'
      }
    ],
    ipInterfaces: [
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, InterfaceMetric: 35 },
      { InterfaceAlias: 'Mobile Tether', InterfaceIndex: 20, InterfaceMetric: 5 } // lower metric beats Wi-Fi
    ],
    routes: [
      {
        InterfaceAlias: 'Mobile Tether',
        InterfaceIndex: 20,
        NextHop: '192.168.42.129',
        RouteMetric: 0
      },
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, NextHop: '192.168.1.1', RouteMetric: 0 }
    ],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    {
      id: 'wifi',
      device: 'Wi-Fi',
      displayName: 'Wi-Fi',
      addresses: [{ address: '192.168.1.50', family: 4, subnet: '192.168.1.0/24' }],
      kind: 'wifi'
    },
    {
      id: 'tether',
      device: 'Mobile Tether',
      displayName: 'Mobile Tether',
      addresses: [{ address: '192.168.42.50', family: 4, subnet: '192.168.42.0/24' }],
      kind: 'usb'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  assert.equal(report.defaultRouteOwner?.interfaceName, 'Mobile Tether')
  assert.equal(report.defaultRouteOwner?.metric, 5)

  const defaultRouteIssue = report.issues.find((i) => i.id === 'defaultRoute')
  assert.ok(defaultRouteIssue, 'Should flag mobile tether beating Wi-Fi')
  assert.ok(defaultRouteIssue.recommendation?.includes('Set-NetIPInterface'))
  assert.ok(defaultRouteIssue.recommendation?.includes('InterfaceMetric 500'))
})

test('diagnoseWindowsNetwork flags IPv4 subnet overlap', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    {
      id: 'wifi',
      device: 'Wi-Fi',
      displayName: 'Home Wi-Fi',
      addresses: [
        { address: '192.168.1.15', family: 4, netmask: '255.255.255.0', subnet: '192.168.1.0/24' }
      ],
      kind: 'wifi'
    },
    {
      id: 'tether',
      device: 'USB Tether',
      displayName: 'Phone Tether',
      addresses: [
        { address: '192.168.1.100', family: 4, netmask: '255.255.255.0', subnet: '192.168.1.0/24' }
      ],
      kind: 'usb'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const overlapIssue = report.issues.find((i) => i.id === 'subnetOverlap')
  assert.ok(overlapIssue, 'Should detect subnet overlap')
  assert.ok(overlapIssue.detail.includes('192.168.1.0/24'))
  assert.equal(overlapIssue.severity, 'warning')
})

test('diagnoseWindowsNetwork detects APIPA address on interface', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    {
      id: 'eth',
      device: 'Ethernet',
      displayName: 'Ethernet',
      addresses: [{ address: '169.254.12.34', family: 4 }],
      kind: 'ethernet'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const apipaIssue = report.issues.find((i) => i.id === 'apipa')
  assert.ok(apipaIssue, 'Should detect APIPA address')
  assert.equal(apipaIssue.severity, 'warning')
})

test('diagnoseWindowsNetwork detects interface with no default gateway', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [{ Name: 'Ethernet 2', InterfaceIndex: 8, Status: 'Up' }],
    ipInterfaces: [{ InterfaceAlias: 'Ethernet 2', InterfaceIndex: 8, InterfaceMetric: 20 }],
    routes: [
      // Only Wi-Fi has a route, Ethernet 2 has no route
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 13, NextHop: '192.168.0.1', RouteMetric: 0 }
    ],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    {
      id: 'eth2',
      device: 'Ethernet 2',
      displayName: 'Ethernet 2',
      addresses: [{ address: '10.50.0.5', family: 4, subnet: '10.50.0.0/24' }],
      kind: 'ethernet'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const noGateway = report.issues.find((i) => i.id === 'noGateway')
  assert.ok(noGateway, 'Should detect missing default gateway on Ethernet 2')
  assert.equal(noGateway.severity, 'warning')
})

test('diagnoseWindowsNetwork surfaces virtual / VPN / WSL adapters', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      {
        Name: 'vEthernet (WSL)',
        InterfaceDescription: 'Hyper-V Virtual Ethernet Adapter',
        InterfaceIndex: 30,
        Virtual: true,
        Status: 'Up'
      },
      {
        Name: 'Tailscale',
        InterfaceDescription: 'Tailscale Tunnel',
        InterfaceIndex: 31,
        Virtual: false,
        Status: 'Up'
      },
      {
        Name: 'Wi-Fi',
        InterfaceDescription: 'Intel Wi-Fi',
        InterfaceIndex: 10,
        Virtual: false,
        Status: 'Up'
      }
    ],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = []

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const virtualIssues = report.issues.filter((i) => i.id === 'virtualAdapter')
  assert.equal(virtualIssues.length, 2)
  assert.ok(virtualIssues.some((v) => v.interfaceName === 'vEthernet (WSL)'))
  assert.ok(virtualIssues.some((v) => v.interfaceName === 'Tailscale'))
})

test('diagnoseWindowsNetwork reports clean status when no issues exist', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      { Name: 'Wi-Fi', InterfaceIndex: 10, NdisPhysicalMedium: 9, Virtual: false, Status: 'Up' }
    ],
    ipInterfaces: [{ InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, InterfaceMetric: 25 }],
    routes: [
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, NextHop: '192.168.1.1', RouteMetric: 0 }
    ],
    domain: false
  }
  const regData = { exists: true, value: 0 } // Simultaneous allowed
  const interfaces: NetworkInterfaceInfo[] = [
    {
      id: 'wifi',
      device: 'Wi-Fi',
      displayName: 'Wi-Fi',
      addresses: [{ address: '192.168.1.55', family: 4, subnet: '192.168.1.0/24' }],
      kind: 'wifi'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  assert.equal(report.supported, true)
  assert.equal(report.issues.length, 0)
})

test('computeIpv4Subnet calculates various CIDR prefixes (/8, /16, /24, /28) and handles invalid inputs', () => {
  assert.equal(computeIpv4Subnet('192.168.1.50', '255.255.255.0'), '192.168.1.0/24')
  assert.equal(computeIpv4Subnet('172.16.20.5', '255.255.0.0'), '172.16.0.0/16')
  assert.equal(computeIpv4Subnet('10.50.2.1', '255.0.0.0'), '10.0.0.0/8')
  assert.equal(computeIpv4Subnet('192.168.1.35', '255.255.255.240'), '192.168.1.32/28')
  assert.equal(computeIpv4Subnet('192.168.1.35', undefined), null)
  assert.equal(computeIpv4Subnet('invalid.ip', '255.255.255.0'), null)
  assert.equal(computeIpv4Subnet('192.168.1.35', '255.255.invalid.0'), null)
  assert.equal(computeIpv4Subnet('300.1.1.1', '255.255.255.0'), null)
})

test('parsePowerShellDoctorData handles malformed JSON safely without throwing', () => {
  const result1 = parsePowerShellDoctorData('{ "adapters": [ unclosed json ...')
  assert.deepEqual(result1, {
    adapters: [],
    ipInterfaces: [],
    routes: [],
    profiles: [],
    domain: false
  })

  const result2 = parsePowerShellDoctorData(
    'PowerShell error occurred: execution policy restricted'
  )
  assert.deepEqual(result2, {
    adapters: [],
    ipInterfaces: [],
    routes: [],
    profiles: [],
    domain: false
  })
})

test('diagnoseWindowsNetwork ignores down / disconnected adapters for virtual adapter warnings', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      {
        Name: 'vEthernet (Default Switch)',
        InterfaceDescription: 'Hyper-V Virtual Ethernet Adapter',
        InterfaceIndex: 40,
        Virtual: true,
        Status: 'Down' // Disconnected / Down
      },
      {
        Name: 'Tailscale',
        InterfaceDescription: 'Tailscale Tunnel',
        InterfaceIndex: 41,
        Virtual: false,
        Status: 'Disconnected' // Disconnected
      }
    ],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = []

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const virtualIssues = report.issues.filter((i) => i.id === 'virtualAdapter')
  assert.equal(
    virtualIssues.length,
    0,
    'Down/disconnected virtual adapters should not generate warnings'
  )
})

test('diagnoseWindowsNetwork handles multiple default routes with different metrics and next hops', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      { Name: 'Ethernet', InterfaceIndex: 5, NdisPhysicalMedium: 14, Virtual: false, Status: 'Up' },
      { Name: 'Wi-Fi', InterfaceIndex: 6, NdisPhysicalMedium: 9, Virtual: false, Status: 'Up' }
    ],
    ipInterfaces: [
      { InterfaceAlias: 'Ethernet', InterfaceIndex: 5, InterfaceMetric: 15 },
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 6, InterfaceMetric: 30 }
    ],
    routes: [
      { InterfaceAlias: 'Ethernet', InterfaceIndex: 5, NextHop: '10.0.0.1', RouteMetric: 5 }, // total 20
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 6, NextHop: '192.168.1.1', RouteMetric: 10 } // total 40
    ],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = []

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  assert.ok(report.defaultRouteOwner)
  assert.equal(report.defaultRouteOwner.interfaceName, 'Ethernet')
  assert.equal(report.defaultRouteOwner.metric, 20)
  assert.equal(report.defaultRouteOwner.nextHop, '10.0.0.1')
})

test('getWindowsDoctorReport respects caching and force rescan', async () => {
  const ifaces: NetworkInterfaceInfo[] = [
    {
      id: 'mock-iface',
      device: 'Wi-Fi',
      displayName: 'Wi-Fi',
      addresses: [{ address: '192.168.1.25', family: 4, subnet: '192.168.1.0/24' }],
      kind: 'wifi'
    }
  ]

  const report1 = await getWindowsDoctorReport(ifaces)
  assert.equal(typeof report1.timestamp, 'number')

  // Calling again with the same interface list should return the exact cached object
  const report2 = await getWindowsDoctorReport(ifaces)
  assert.strictEqual(report1, report2, 'Should return cached report instance')

  // Calling with force = true should refresh
  const report3 = await getWindowsDoctorReport(ifaces, true)
  assert.ok(report3)
  assert.equal(typeof report3.timestamp, 'number')
})

// --- 4. User-Friendly Summaries & Automated Fix Metadata Tests ---

test('diagnoseWindowsNetwork attaches plain English summaries and fix metadata for fMinimizeConnections', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 1 }
  const report = diagnoseWindowsNetwork({ psData, regData, interfaces: [] })

  const issue = report.issues.find((i) => i.id === 'fMinimizeConnections')
  assert.ok(issue)
  assert.ok(issue.summary && issue.summary.includes('disconnect Wi-Fi'))
  assert.equal(issue.fix?.action, 'system')
  assert.equal(issue.fix?.type, 'enableSimultaneousConnections')
  assert.equal(issue.fix?.label, 'Allow Simultaneous Connections')
})

test('diagnoseWindowsNetwork attaches route priority fix and summary for defaultRoute', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      { Name: 'Wi-Fi', InterfaceIndex: 10, NdisPhysicalMedium: 9, Status: 'Up' },
      { Name: 'Phone Tether', InterfaceIndex: 20, NdisPhysicalMedium: 0, Status: 'Up' }
    ],
    ipInterfaces: [
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, InterfaceMetric: 35 },
      { InterfaceAlias: 'Phone Tether', InterfaceIndex: 20, InterfaceMetric: 5 }
    ],
    routes: [
      { InterfaceAlias: 'Phone Tether', InterfaceIndex: 20, RouteMetric: 0 },
      { InterfaceAlias: 'Wi-Fi', InterfaceIndex: 10, RouteMetric: 0 }
    ],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    { id: 'wifi', device: 'Wi-Fi', displayName: 'Wi-Fi', addresses: [], kind: 'wifi' },
    {
      id: 'tether',
      device: 'Phone Tether',
      displayName: 'Phone Tether',
      addresses: [],
      kind: 'usb'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const issue = report.issues.find((i) => i.id === 'defaultRoute')
  assert.ok(issue)
  assert.ok(issue.summary && issue.summary.includes('mobile data'))
  assert.equal(issue.fix?.action, 'system')
  assert.equal(issue.fix?.type, 'setInterfaceMetric')
  assert.equal(issue.fix?.interfaceIndex, 20)
  assert.equal(issue.interfaceIndex, 20)
})

test('diagnoseWindowsNetwork attaches disableInPlexo fix for virtual adapter and apipa', () => {
  const psData: RawPowerShellDoctorData = {
    adapters: [
      {
        Name: 'Tailscale',
        InterfaceDescription: 'Tailscale Tunnel',
        InterfaceIndex: 10,
        Virtual: true,
        Status: 'Up'
      }
    ],
    ipInterfaces: [],
    routes: [],
    domain: false
  }
  const regData = { exists: true, value: 0 }
  const interfaces: NetworkInterfaceInfo[] = [
    { id: 'ts-id', device: 'Tailscale', displayName: 'Tailscale', addresses: [], kind: 'other' },
    {
      id: 'apipa-id',
      device: 'Ethernet',
      displayName: 'Local Cable',
      addresses: [{ address: '169.254.1.2', family: 4 }],
      kind: 'ethernet'
    }
  ]

  const report = diagnoseWindowsNetwork({ psData, regData, interfaces })
  const virtualIssue = report.issues.find((i) => i.id === 'virtualAdapter')
  assert.ok(virtualIssue)
  assert.equal(virtualIssue.fix?.action, 'plexo')
  assert.equal(virtualIssue.fix?.type, 'disableInPlexo')
  assert.equal(virtualIssue.fix?.interfaceId, 'ts-id')

  const apipaIssue = report.issues.find((i) => i.id === 'apipa')
  assert.ok(apipaIssue)
  assert.equal(apipaIssue.fix?.action, 'plexo')
  assert.equal(apipaIssue.fix?.type, 'disableInPlexo')
  assert.equal(apipaIssue.fix?.interfaceId, 'apipa-id')
})

test('applyWindowsDoctorFix validates interfaceIndex for setInterfaceMetric', async () => {
  const result = await applyWindowsDoctorFix({
    type: 'setInterfaceMetric',
    interfaceIndex: -1
  })
  assert.equal(result.success, false)
  assert.ok(result.error?.includes('Invalid network interface index'))
})

test('applyWindowsDoctorFix rejects unknown fix types', async () => {
  const result = await applyWindowsDoctorFix({
    // @ts-expect-error test invalid type
    type: 'invalidType'
  })
  assert.equal(result.success, false)
  assert.ok(result.error?.includes('Unknown fix type'))
})
