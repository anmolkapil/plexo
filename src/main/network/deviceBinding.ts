import { createRequire } from 'node:module'
import { connect, Socket, type SocketConstructorOpts, type TcpNetConnectOpts } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkRoute } from './routes'

// On Linux and Windows, localAddress selects the source IP but not necessarily the outgoing
// interface. Pin the socket before handing it to Node: SO_BINDTODEVICE on Linux (unprivileged
// since 5.7), IP[V6]_UNICAST_IF on Windows. macOS already routes by source address.

const AF_INET = 2
const AF_INET6 = 10
const SOCK_STREAM = 1
const SOCK_CLOEXEC = 0o2000000
const SOL_SOCKET = 1
const SO_BINDTODEVICE = 25
const WINDOWS_AF_INET6 = 23
const IPPROTO_TCP = 6
const IPPROTO_IP = 0
const IPPROTO_IPV6 = 41
const UNICAST_IF = 31
const WSA_FLAG_OVERLAPPED = 0x01
const WSA_FLAG_NO_HANDLE_INHERIT = 0x80

interface Libc {
  socket: (domain: number, type: number, protocol: number) => number
  setsockopt: (fd: number, level: number, name: number, value: string, length: number) => number
  close: (fd: number) => number
  errno: () => number
}

type OpenSocket = (device: string, family: 4 | 6) => Socket
/** Set once the support check below passes; until then everything falls back to localAddress. */
let openSocket: OpenSocket | null = null
let support: Promise<boolean> | null = null

function openOnDevice(lib: Libc, device: string, family: 4 | 6): number {
  const fd = lib.socket(family === 6 ? AF_INET6 : AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0)
  if (fd < 0) throw new Error(`socket() failed (errno ${lib.errno()})`)
  if (
    lib.setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, device, Buffer.byteLength(device) + 1) !== 0
  ) {
    const errno = lib.errno()
    lib.close(fd)
    throw new Error(`Couldn't bind a socket to ${device} (errno ${errno})`)
  }
  return fd
}

interface TcpHandle {
  open(socket: number): number
  close(): void
}

function windowsSocketFactory(): OpenSocket {
  const koffi: typeof import('koffi') = createRequire(__filename)('koffi')
  const ws = koffi.load('ws2_32.dll')
  const ip = koffi.load('iphlpapi.dll')
  const socket = ws.func('intptr_t __stdcall WSASocketW(int, int, int, void *, uint32_t, uint32_t)')
  const setOption = ws.func('int __stdcall setsockopt(intptr_t, int, int, const void *, int)')
  const close = ws.func('int __stdcall closesocket(intptr_t)')
  const lastError = ws.func('int __stdcall WSAGetLastError()')
  const toLuid = ip.func('uint32_t __stdcall ConvertInterfaceAliasToLuid(const char16_t *, void *)')
  const toIndex = ip.func('uint32_t __stdcall ConvertInterfaceLuidToIndex(const void *, void *)')
  // shortcut: process.binding('tcp_wrap') is internal (DEP0111, docs-only); if a future Electron drops it, the support probe fails and Plexo falls back to localAddress
  const { TCP, constants } = (
    process as NodeJS.Process & {
      binding(name: 'tcp_wrap'): {
        TCP: new (type: number) => TcpHandle
        constants: { SOCKET: number }
      }
    }
  ).binding('tcp_wrap')

  return (device, family) => {
    const luid = Buffer.alloc(8)
    const index = Buffer.alloc(4)
    const status = toLuid(device, luid) || toIndex(luid, index)
    if (status) throw new Error(`Couldn't resolve adapter ${device} (Windows ${status})`)
    // IPv6 takes the native ULONG; IPv4 takes the same index in network byte order.
    if (family === 4) index.writeUInt32BE(index.readUInt32LE())
    const raw: number | bigint = socket(
      family === 6 ? WINDOWS_AF_INET6 : AF_INET,
      SOCK_STREAM,
      IPPROTO_TCP,
      null,
      0,
      WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT
    )
    if (raw === -1 || raw === -1n) throw new Error(`WSASocketW failed (WSA ${lastError()})`)
    let handle: TcpHandle | undefined
    let adopted = false
    try {
      if (raw < 0 || raw > 0x7fffffff)
        throw new Error('SOCKET exceeds the signed int range of TCP.open')
      const level = family === 6 ? IPPROTO_IPV6 : IPPROTO_IP
      if (setOption(raw, level, UNICAST_IF, index, index.length) !== 0) {
        throw new Error(`Couldn't bind a socket to ${device} (WSA ${lastError()})`)
      }
      handle = new TCP(constants.SOCKET)
      const err = handle.open(Number(raw))
      if (err) throw new Error(`TCP.open failed (${err})`)
      adopted = true
      return new Socket({ handle, manualStart: true } as SocketConstructorOpts)
    } catch (error) {
      if (!adopted) close(raw)
      handle?.close()
      throw error
    }
  }
}

/** Whether each network can carry its own connections. */
export function deviceBindingSupported(): Promise<boolean> {
  support ??= (async () => {
    try {
      if (process.platform === 'win32') {
        const candidate = windowsSocketFactory()
        const loopback = deviceFor('127.0.0.1')
        if (!loopback) throw new Error('No IPv4 loopback adapter')
        candidate(loopback, 4).destroy()
        openSocket = candidate
        return true
      }
      if (process.platform !== 'linux') return true
      const { default: koffi } = await import('koffi')
      const lib = koffi.load('libc.so.6')
      const candidate: Libc = {
        socket: lib.func('int socket(int, int, int)'),
        setsockopt: lib.func('int setsockopt(int, int, int, const char *, uint32_t)'),
        close: lib.func('int close(int)'),
        errno: () => koffi.errno()
      }
      // Loopback always exists, so this only fails when the kernel refuses (EPERM before 5.7).
      candidate.close(openOnDevice(candidate, 'lo', 4))
      openSocket = (device, family) =>
        new Socket({
          fd: openOnDevice(candidate, device, family),
          manualStart: true
        } as SocketConstructorOpts)
      return true
    } catch (error) {
      console.warn('Per-network binding unavailable, using the default route:', error)
      return false
    }
  })()
  return support
}

/** A TCP connection through the already chosen device, to a numeric remote address. */
export function connectRoute(route: NetworkRoute, port: number): Socket {
  const { device, localAddress, remoteAddress, family } = route
  const loopback = remoteAddress === '::1' || remoteAddress.startsWith('127.')
  if (loopback) {
    return connect({ host: remoteAddress, port, localAddress, family })
  }

  return dial(device, { host: remoteAddress, port, localAddress, family })
}

function dial(device: string | undefined, options: TcpNetConnectOpts & { family?: 4 | 6 }): Socket {
  if (!openSocket) return connect(options)
  let socket: Socket | undefined
  try {
    if (!device && options.localAddress) {
      device = deviceFor(options.localAddress)
      if (!device && process.platform === 'win32')
        throw new Error(`No adapter owns ${options.localAddress}`)
    }
    if (!device) return connect(options)
    const family =
      options.family ?? (options.localAddress?.includes(':') || options.host?.includes(':') ? 6 : 4)
    socket = openSocket(device, family)
    return socket.connect({ ...options, family })
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const failed = socket ?? new Socket()
    process.nextTick(() => failed.destroy(error as Error))
    return failed
  }
}

function deviceFor(localAddress: string): string | undefined {
  for (const [device, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some((addr) => addr.address === localAddress)) return device
  }
  return undefined
}

/** A TCP connection to host:port that leaves through the interface owning `localAddress` or `device`. */
export function connectFrom(
  localAddress: string | undefined,
  host: string,
  port: number,
  deviceName?: string
): Socket {
  const isLoopback = host === 'localhost' || host.startsWith('127.') || host === '::1'
  if (isLoopback) {
    return connect({ host, port })
  }

  return dial(deviceName, { host, port, localAddress: localAddress || undefined })
}
