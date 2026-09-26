import { connect, Socket, type SocketConstructorOpts } from 'node:net'
import type { NetworkRoute } from './routes'

// Linux picks a socket's outgoing interface from the routing table alone: binding to an
// interface's IP (Node's `localAddress`) still sends the packets out the default route, where the
// network that doesn't own that IP drops them. SO_BINDTODEVICE pins the socket to the interface
// itself. Node has no setsockopt, so the socket is made through libc and handed to Node as an fd.
// Unprivileged since Linux 5.7. macOS and Windows already route by source address.

const AF_INET = 2
const AF_INET6 = 10
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
      candidate.close(openOnDevice(candidate, 'lo', 4))
      libc = candidate
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
  if (!libc || loopback) {
    return connect({ host: remoteAddress, port, localAddress, family })
  }

  let fd: number
  try {
    fd = openOnDevice(libc, device, family)
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const socket = new Socket()
    process.nextTick(() => socket.destroy(error as Error))
    return socket
  }
  // manualStart: a socket wrapped around an fd starts reading at once, before it's connected.
  // Bind both the device and source address: an interface may have several IPv6 addresses.
  return new Socket({ fd, manualStart: true } as SocketConstructorOpts).connect({
    host: remoteAddress,
    port,
    localAddress,
    family
  })
}
