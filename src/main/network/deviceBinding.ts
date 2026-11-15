import { connect, Socket, type SocketConstructorOpts } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { NetworkRoute } from './routes'

// Linux picks a socket's outgoing interface from the routing table alone: binding to an
// interface's IP (Node's `localAddress`) still sends the packets out the default route, where the
// network that doesn't own that IP drops them. SO_BINDTODEVICE pins the socket to the interface
// itself. Node has no setsockopt, so the socket is made through libc and handed to Node as an fd.
// Unprivileged since Linux 5.7. macOS routes by source address; Windows requires IP_UNICAST_IF.

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

/** Warn once per process; a missing helper must never block an otherwise ordinary download. */
let warnedWindowsFallback = false
export function warnWindowsRoutingFallback(reason: string): void {
  if (warnedWindowsFallback) return
  warnedWindowsFallback = true
  console.warn(`Windows per-interface routing unavailable (${reason}); falling back to localAddress`)
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError')

/** Wait for the TCP handshake without leaving an untracked socket behind on abort. */
async function waitForTcpConnect(socket: Socket, signal?: AbortSignal): Promise<Socket> {
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        socket.off('connect', onConnect)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onConnect = (): void => finish()
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new Error('TCP connection closed'))
      const onAbort = (): void => {
        socket.destroy()
        finish(abortError())
      }
      if (signal?.aborted) return onAbort()
      socket.once('connect', onConnect)
      socket.once('error', onError)
      socket.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (!socket.connecting && socket.readyState === 'open') onConnect()
    })
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

function helperSocketError(code: string): NodeJS.ErrnoException {
  const messages: Record<string, string> = {
    ECONNREFUSED: 'Connection refused',
    ETIMEDOUT: 'Connection timed out',
    EHOSTUNREACH: 'Host unreachable',
    ENETUNREACH: 'Network unreachable',
    EADDRNOTAVAIL: 'Address not available',
    EACCES: 'Permission denied',
    ECONNRESET: 'Connection reset',
    ENODEV: 'Selected network adapter not found'
  }
  const error = new Error(messages[code] ?? `Windows route helper: ${code}`) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** Log the confirmed Windows adapter binding once per local address, not once per chunk. */
const loggedWindowsBindings = new Set<string>()
function logWindowsRouting(route: NetworkRoute, index: number): void {
  const key = `${route.localAddress}/${index}`
  if (loggedWindowsBindings.has(key)) return
  loggedWindowsBindings.add(key)
  console.info(`Windows route: ${route.device} (${route.localAddress}) using IP_UNICAST_IF ${index}`)
}

/** Open a Windows IPv4 socket through IP_UNICAST_IF, with safe fallback if unavailable. */
export async function connectRouteAsync(
  route: NetworkRoute,
  port: number,
  signal?: AbortSignal
): Promise<Socket> {
  const plain = (): Promise<Socket> => waitForTcpConnect(connectRoute(route, port), signal)
  if (signal?.aborted) throw abortError()
  if (
    process.platform !== 'win32' ||
    route.family !== 4 ||
    route.remoteAddress.startsWith('127.') ||
    route.remoteAddress === '::1'
  ) {
    return plain()
  }
  // No cached InterfaceIndex is needed: the helper derives it from localAddress.

  let helper: { port: number; token: string }
  try {
    const { startWindowsRouteHelper } = await import('./windowsRouteHelper')
    helper = await startWindowsRouteHelper()
  } catch (error) {
    if (signal?.aborted) throw abortError()
    warnWindowsRoutingFallback(error instanceof Error ? error.message : String(error))
    return plain()
  }
  if (signal?.aborted) throw abortError()

  const socket = connect({ host: '127.0.0.1', port: helper.port })
  try {
    await waitForTcpConnect(socket, signal)
    if (signal?.aborted) throw abortError()
    const header = JSON.stringify({
      token: helper.token,
      remoteAddress: route.remoteAddress,
      remotePort: port,
      localAddress: route.localAddress,
      // The helper resolves the current interface index from this source IP.
      // Older callers may still send InterfaceIndex, but it is no longer authoritative.
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      let response = Buffer.alloc(0)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error: Error): void => finish(error)
      const onClose = (): void => finish(new Error('Windows route helper disconnected'))
      const onAbort = (): void => {
        socket.destroy()
        finish(abortError())
      }
      const onData = (chunk: Buffer): void => {
        response = Buffer.concat([response, chunk])
        if (response.length > 4096) return finish(new Error('Invalid helper response'))
        const eol = response.indexOf(10)
        if (eol < 0) return
        const status = response.subarray(0, eol).toString('ascii').trim()
        const success = /^OK (\d+)$/.exec(status)
        if (!success) {
          const match = /^ERR (E[A-Z0-9_]+)$/.exec(status)
          return finish(
            match ? helperSocketError(match[1]) : new Error('Windows route helper refused connection')
          )
        }
        const interfaceIndex = Number(success[1])
        logWindowsRouting(route, interfaceIndex)
        const leftover = response.subarray(eol + 1)
        if (leftover.length) socket.unshift(leftover)
        finish()
      }
      const timer = setTimeout(
        () => finish(helperSocketError('ETIMEDOUT')),
        10000
      )
      if (signal?.aborted) return onAbort()
      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.write(header + '\n')
    })
    return socket
  } catch (error) {
    socket.destroy()
    // An adapter/IP that has disappeared is not a reason to break all Windows downloads.
    if ((error as NodeJS.ErrnoException).code === 'ENODEV') {
      if (signal?.aborted) throw abortError()
      warnWindowsRoutingFallback('source IP is no longer assigned to an adapter')
      return plain()
    }
    if (process.env.PLEXO_ROUTE_DEBUG === '1') {
      console.warn('Windows route helper connection failed:', route.device, error)
    }
    throw error
  }
}

function deviceFor(localAddress: string, host: string): string | undefined {
  if (host === 'localhost' || host.startsWith('127.') || host === '::1') return undefined
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

  const device = deviceName ?? (libc && localAddress ? deviceFor(localAddress, host) : undefined)
  if (!libc || !device) {
    return connect({ host, port, localAddress: localAddress || undefined })
  }

  const isIpv6 = Boolean(localAddress?.includes(':') || host.includes(':'))
  const family = isIpv6 ? 6 : 4
  let fd: number
  try {
    fd = openOnDevice(libc, device, family)
  } catch (error) {
    // The interface vanished since it was listed — surface it like any other connect error.
    const socket = new Socket()
    process.nextTick(() => socket.destroy(error as Error))
    return socket
  }
  return new Socket({ fd, manualStart: true } as SocketConstructorOpts).connect({
    host,
    port,
    localAddress: localAddress || undefined,
    family
  })
}
