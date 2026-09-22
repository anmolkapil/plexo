import type { ClientRequestArgs } from 'node:http'
import { connect, isIP, Socket, type SocketConstructorOpts } from 'node:net'
import { networkInterfaces } from 'node:os'
import { connect as tlsConnect } from 'node:tls'

// Linux picks a socket's outgoing interface from the routing table alone: binding to an
// interface's IP (Node's `localAddress`) still sends the packets out the default route, where the
// network that doesn't own that IP drops them. SO_BINDTODEVICE pins the socket to the interface
// itself. Node has no setsockopt, so the socket is made through libc and handed to Node as an fd.
// Unprivileged since Linux 5.7. macOS and Windows already route by source address.

const AF_INET = 2
const SOCK_STREAM = 1
const SOCK_CLOEXEC = 0o2000000
const SOL_SOCKET = 1
const SO_BINDTODEVICE = 25

interface Libc {
  socket: (domain: number, type: number, protocol: number) => number
  setsockopt: (fd: number, level: number, name: number, value: string, length: number) => number
  close: (fd: number) => number
  errno: () => number
}

/** Set once the support check below passes; until then everything falls back to localAddress. */
let libc: Libc | null = null
let support: Promise<boolean> | null = null

function openOnDevice(lib: Libc, device: string): number {
  const fd = lib.socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0)
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

/** Whether each network can carry its own connections. Always true off Linux. */
export function deviceBindingSupported(): Promise<boolean> {
  support ??= (async () => {
    if (process.platform !== 'linux') return true
    try {
      const { default: koffi } = await import('koffi')
      const lib = koffi.load('libc.so.6')
      const candidate: Libc = {
        socket: lib.func('int socket(int, int, int)'),
        setsockopt: lib.func('int setsockopt(int, int, int, const char *, uint32_t)'),
        close: lib.func('int close(int)'),
        errno: () => koffi.errno()
      }
      // Loopback always exists, so this only fails when the kernel refuses (EPERM before 5.7).
      candidate.close(openOnDevice(candidate, 'lo'))
      libc = candidate
      return true
    } catch (error) {
      console.warn('Per-network binding unavailable, using the default route:', error)
      return false
    }
  })()
  return support
}

/** The interface to pin a connection to `host` to, if any. Loopback traffic never touches a
 * network, and a socket pinned to one can't reach it. */
function deviceFor(localAddress: string, host: string): string | undefined {
  if (host === 'localhost' || host.startsWith('127.')) return undefined
  for (const [device, addresses] of Object.entries(networkInterfaces())) {
    if (addresses?.some((addr) => addr.address === localAddress)) return device
  }
  return undefined
}

/** A TCP connection to host:port that leaves through the interface owning `localAddress`. */
export function connectFrom(localAddress: string, host: string, port: number): Socket {
  const device = libc && deviceFor(localAddress, host)
  if (!libc || !device) return connect({ host, port, localAddress, family: 4 })

  let fd: number
  try {
    fd = openOnDevice(libc, device)
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const socket = new Socket()
    process.nextTick(() => socket.destroy(error as Error))
    return socket
  }
  // manualStart: a socket wrapped around an fd starts reading at once, before it's connected.
  // No localAddress: the device already picks the source IP, and a second bind would fail.
  return new Socket({ fd, manualStart: true } as SocketConstructorOpts).connect({
    host,
    port,
    family: 4
  })
}

/** Options that route an http(s) request for `target` through the interface owning
 * `localAddress`. Spread them after `port`. */
export function routeFrom(
  localAddress: string,
  target: URL
): Pick<
  ClientRequestArgs,
  'localAddress' | 'family' | 'createConnection' | 'port' | 'defaultPort'
> {
  // localAddress is always an IPv4 interface address, so the remote host has to resolve to
  // IPv4 too, or binding fails with EINVAL when DNS hands back an IPv6 address instead.
  if (!libc || !deviceFor(localAddress, target.hostname)) return { localAddress, family: 4 }

  const secure = target.protocol === 'https:'
  const defaultPort = secure ? 443 : 80
  const port = Number(target.port) || defaultPort
  const host = target.hostname
  return {
    // Without an agent, Node can't infer the scheme's port and would write it into Host.
    port,
    defaultPort,
    createConnection: () => {
      const socket = connectFrom(localAddress, host, port)
      return secure ? tlsConnect({ socket, servername: isIP(host) ? undefined : host }) : socket
    }
  }
}
