import { isIP, Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { ProxyConfig } from '../../shared/types'
import { connectFrom } from './deviceBinding'

const PROXY_CONNECT_TIMEOUT_MS = 15_000

/** Reads exactly `length` bytes from a socket, or rejects on error, close, or timeout. */
function readExactBytes(socket: Socket | TLSSocket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length >= length) {
        cleanup()
        const result = buffer.subarray(0, length)
        const remainder = buffer.subarray(length)
        if (remainder.length > 0) {
          socket.unshift(remainder)
        }
        resolve(result)
      }
    }

    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onClose = (): void => {
      cleanup()
      reject(new Error('Proxy connection closed unexpectedly'))
    }

    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Reads data until `\r\n\r\n` HTTP header delimiter is reached. */
function readHttpHeaders(socket: Socket | TLSSocket): Promise<{ headers: string; status: number }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const delimiterIndex = buffer.indexOf('\r\n\r\n')
      if (delimiterIndex !== -1) {
        cleanup()
        const headerText = buffer.subarray(0, delimiterIndex).toString('utf-8')
        const remainder = buffer.subarray(delimiterIndex + 4)
        if (remainder.length > 0) {
          socket.unshift(remainder)
        }
        const statusMatch = /^HTTP\/\d\.\d\s+(\d+)/i.exec(headerText)
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0
        resolve({ headers: headerText, status })
      }
    }

    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const onClose = (): void => {
      cleanup()
      reject(new Error('Proxy connection closed while reading response headers'))
    }

    const cleanup = (): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Establishes an HTTP CONNECT tunnel through an HTTP or HTTPS proxy. */
async function connectHttpTunnel(
  localAddress: string,
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig
): Promise<Socket | TLSSocket> {
  const isHttpsProxy = proxy.type === 'https'

  // 1. Connect TCP socket bound to interface
  const rawSocket: Socket = connectFrom(localAddress, proxy.host, proxy.port)

  await new Promise<void>((resolve, reject) => {
    rawSocket.once('connect', () => resolve())
    rawSocket.once('error', reject)
    rawSocket.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () =>
      reject(new Error(`Connecting to proxy ${proxy.host}:${proxy.port} timed out`))
    )
  })
  rawSocket.setTimeout(0)

  // 2. If HTTPS proxy, wrap in TLS to proxy first
  let proxySocket: Socket | TLSSocket = rawSocket
  if (isHttpsProxy) {
    proxySocket = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({
        socket: rawSocket,
        servername: isIP(proxy.host) ? undefined : proxy.host
      })
      tls.once('secureConnect', () => resolve(tls))
      tls.once('error', reject)
    })
  }

  // 3. Send HTTP CONNECT request
  let connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`
  if (proxy.username) {
    const credentials = Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')
    connectRequest += `Proxy-Authorization: Basic ${credentials}\r\n`
  }
  connectRequest += `User-Agent: Plexo/1.0\r\nProxy-Connection: Keep-Alive\r\n\r\n`

  proxySocket.write(connectRequest)

  // 4. Read HTTP 200 response
  const { status, headers } = await readHttpHeaders(proxySocket)
  if (status < 200 || status >= 300) {
    proxySocket.destroy()
    if (status === 407) {
      throw new Error(`Proxy authentication required (HTTP 407) on ${proxy.host}:${proxy.port}`)
    }
    const firstLine = headers.split('\r\n')[0] || `HTTP ${status}`
    throw new Error(`Proxy CONNECT failed: ${firstLine}`)
  }

  return proxySocket
}

/** Establishes a SOCKS5 tunnel with optional username/password authentication (RFC 1928 / RFC 1929). */
async function connectSocks5Tunnel(
  localAddress: string,
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig
): Promise<Socket> {
  const socket = connectFrom(localAddress, proxy.host, proxy.port)

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
    socket.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () =>
      reject(new Error(`Connecting to SOCKS5 proxy ${proxy.host}:${proxy.port} timed out`))
    )
  })
  socket.setTimeout(0)

  const hasAuth = Boolean(proxy.username)
  // Handshake greeting: [VER=0x05, NMETHODS, METHODS...]
  const greeting = hasAuth
    ? Buffer.from([0x05, 0x02, 0x00, 0x02]) // No Auth (0x00) & User/Password (0x02)
    : Buffer.from([0x05, 0x01, 0x00]) // No Auth (0x00)
  socket.write(greeting)

  const methodResponse = await readExactBytes(socket, 2)
  if (methodResponse[0] !== 0x05) {
    socket.destroy()
    throw new Error(`Invalid SOCKS5 version response (${methodResponse[0]})`)
  }

  const selectedMethod = methodResponse[1]
  if (selectedMethod === 0xff) {
    socket.destroy()
    throw new Error('SOCKS5 proxy rejected authentication methods')
  }

  // Handle Username/Password sub-negotiation (RFC 1929)
  if (selectedMethod === 0x02) {
    const user = Buffer.from(proxy.username ?? '', 'utf-8')
    const pass = Buffer.from(proxy.password ?? '', 'utf-8')
    const authRequest = Buffer.concat([
      Buffer.from([0x01, user.length]),
      user,
      Buffer.from([pass.length]),
      pass
    ])
    socket.write(authRequest)

    const authResponse = await readExactBytes(socket, 2)
    if (authResponse[1] !== 0x00) {
      socket.destroy()
      throw new Error(`SOCKS5 authentication failed on ${proxy.host}:${proxy.port}`)
    }
  }

  // Connect command: [VER=0x05, CMD=0x01 (CONNECT), RSV=0x00, ATYP, ADDR, PORT]
  let addrBuf: Buffer
  const ipType = isIP(targetHost)
  if (ipType === 4) {
    const parts = targetHost.split('.').map(Number)
    addrBuf = Buffer.from([0x01, ...parts])
  } else if (ipType === 6) {
    socket.destroy()
    throw new Error('IPv6 addresses are not supported through SOCKS5 in this version')
  } else {
    // SOCKS5h Domain name address (0x03)
    const hostBuf = Buffer.from(targetHost, 'utf-8')
    addrBuf = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf])
  }

  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(targetPort, 0)

  const connectBuf = Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrBuf, portBuf])
  socket.write(connectBuf)

  // Read response: [VER, REP, RSV, ATYP, BND.ADDR, BND.PORT]
  const header = await readExactBytes(socket, 4)
  const rep = header[1]
  if (rep !== 0x00) {
    socket.destroy()
    const errorMessages: Record<number, string> = {
      0x01: 'General SOCKS server failure',
      0x02: 'Connection not allowed by ruleset',
      0x03: 'Network unreachable',
      0x04: 'Host unreachable',
      0x05: 'Connection refused',
      0x06: 'TTL expired',
      0x07: 'Command not supported',
      0x08: 'Address type not supported'
    }
    throw new Error(
      `SOCKS5 connection to ${targetHost}:${targetPort} failed: ${errorMessages[rep] || `Error code 0x${rep.toString(16)}`}`
    )
  }

  // Read remaining bound address and port to clean socket buffer
  const atyp = header[3]
  if (atyp === 0x01) {
    await readExactBytes(socket, 4 + 2) // 4 bytes IPv4 + 2 bytes port
  } else if (atyp === 0x03) {
    const lenBuf = await readExactBytes(socket, 1)
    await readExactBytes(socket, lenBuf[0] + 2)
  } else if (atyp === 0x04) {
    await readExactBytes(socket, 16 + 2)
  }

  return socket
}

/** Establishes a SOCKS4 / SOCKS4a tunnel. */
async function connectSocks4Tunnel(
  localAddress: string,
  targetHost: string,
  targetPort: number,
  proxy: ProxyConfig
): Promise<Socket> {
  const socket = connectFrom(localAddress, proxy.host, proxy.port)

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
    socket.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () =>
      reject(new Error(`Connecting to SOCKS4 proxy ${proxy.host}:${proxy.port} timed out`))
    )
  })
  socket.setTimeout(0)

  const isIpv4 = isIP(targetHost) === 4
  const userId = Buffer.from(proxy.username ?? '', 'utf-8')
  const portBuf = Buffer.alloc(2)
  portBuf.writeUInt16BE(targetPort, 0)

  let requestBuf: Buffer
  if (isIpv4) {
    const parts = targetHost.split('.').map(Number)
    requestBuf = Buffer.concat([
      Buffer.from([0x04, 0x01]),
      portBuf,
      Buffer.from(parts),
      userId,
      Buffer.from([0x00])
    ])
  } else {
    // SOCKS4a: IP is set to 0.0.0.x with non-zero x, followed by host string
    const hostBuf = Buffer.from(targetHost, 'utf-8')
    requestBuf = Buffer.concat([
      Buffer.from([0x04, 0x01]),
      portBuf,
      Buffer.from([0x00, 0x00, 0x00, 0x01]),
      userId,
      Buffer.from([0x00]),
      hostBuf,
      Buffer.from([0x00])
    ])
  }

  socket.write(requestBuf)

  const response = await readExactBytes(socket, 8)
  const status = response[1]
  if (status !== 0x5a) {
    socket.destroy()
    const errorMessages: Record<number, string> = {
      0x5b: 'Request rejected or failed',
      0x5c: 'Request failed: client not running identd',
      0x5d: 'Request failed: identd reported different user-id'
    }
    throw new Error(
      `SOCKS4 connection to ${targetHost}:${targetPort} failed: ${errorMessages[status] || `Error code 0x${status.toString(16)}`}`
    )
  }

  return socket
}

/**
 * Creates an outbound socket connected to `targetHost:targetPort` through the specified `proxy`,
 * bound to the physical network interface owning `localAddress`. If `secure` is true, performs
 * end-to-end TLS handshake with SNI through the established tunnel.
 */
export async function createProxyConnection(
  localAddress: string,
  targetHost: string,
  targetPort: number,
  secure: boolean,
  proxy: ProxyConfig
): Promise<Socket | TLSSocket> {
  let tunnelSocket: Socket | TLSSocket

  switch (proxy.type) {
    case 'http':
    case 'https':
      tunnelSocket = await connectHttpTunnel(localAddress, targetHost, targetPort, proxy)
      break
    case 'socks5':
      tunnelSocket = await connectSocks5Tunnel(localAddress, targetHost, targetPort, proxy)
      break
    case 'socks4':
      tunnelSocket = await connectSocks4Tunnel(localAddress, targetHost, targetPort, proxy)
      break
    default:
      throw new Error(`Unsupported proxy type: ${String(proxy.type)}`)
  }

  if (secure) {
    return new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({
        socket: tunnelSocket,
        servername: isIP(targetHost) ? undefined : targetHost
      })
      tls.once('secureConnect', () => resolve(tls))
      tls.once('error', (err) => {
        tunnelSocket.destroy()
        reject(err)
      })
    })
  }

  return tunnelSocket
}
