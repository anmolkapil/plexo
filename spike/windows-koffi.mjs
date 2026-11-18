// Throwaway spike for PR #274: can Plexo pin a TCP connection to one Windows adapter
// (IP_UNICAST_IF) in-process with koffi, the way deviceBinding.ts does SO_BINDTODEVICE on Linux,
// instead of shipping a separate helper exe? Run on Windows under Node and under Electron.
import { execFileSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { createServer, connect, Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import koffi from 'koffi'

const AF_INET = 2
const SOCK_STREAM = 1
const IPPROTO_TCP = 6
const IPPROTO_IP = 0
const IP_UNICAST_IF = 31
const WSA_FLAG_OVERLAPPED = 0x01 // libuv needs it to attach the socket to its completion port

const ws2 = koffi.load('ws2_32.dll')
const WSASocketW = ws2.func('intptr_t __stdcall WSASocketW(int, int, int, void *, uint32_t, uint32_t)')
const setsockopt = ws2.func('int __stdcall setsockopt(intptr_t, int, int, const void *, int)')
const closesocket = ws2.func('int __stdcall closesocket(intptr_t)')
const WSAGetLastError = ws2.func('int __stdcall WSAGetLastError()')

const results = []
const record = (name, expected, actual, detail = '') => {
  const ok = expected === actual
  results.push({ name, expected, actual, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: expected ${expected}, got ${actual} ${detail}`)
}

function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8'
  }).trim()
}

// The TCP handle class that net.Socket wraps; process.binding first, a listening server's as backup.
async function tcpHandleClass() {
  try {
    const { TCP, constants } = process.binding('tcp_wrap')
    return { TCP, SOCKET: constants.SOCKET, via: 'process.binding' }
  } catch (error) {
    console.log('process.binding(tcp_wrap) unavailable:', error.message)
    const server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const TCP = server._handle.constructor
    server.close()
    return { TCP, SOCKET: 0, via: 'server handle' }
  }
}

/** A Winsock socket with IP_UNICAST_IF set (index 0 = leave unset). Returns the SOCKET value. */
function openSocket(interfaceIndex) {
  const sock = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, null, 0, WSA_FLAG_OVERLAPPED)
  if (sock === -1) throw new Error(`WSASocketW failed (WSA ${WSAGetLastError()})`)
  if (interfaceIndex) {
    const value = Buffer.alloc(4)
    value.writeUInt32BE(interfaceIndex) // IPv4 takes the index in network byte order
    if (setsockopt(sock, IPPROTO_IP, IP_UNICAST_IF, value, 4) !== 0) {
      const code = WSAGetLastError()
      closesocket(sock)
      throw new Error(`setsockopt(IP_UNICAST_IF=${interfaceIndex}) failed (WSA ${code})`)
    }
  }
  return sock
}

let tcp
/** Hand the raw SOCKET to Node, unconnected; Node then binds and connects it as usual. */
function adopt(sock) {
  const handle = new tcp.TCP(tcp.SOCKET)
  const err = handle.open(Number(sock))
  if (err) {
    closesocket(sock)
    throw new Error(`TCP.open failed (${err})`)
  }
  // manualStart: reading an unconnected socket fails; Node starts reading once connected.
  return new Socket({ handle, manualStart: true })
}

const pinned = (index, opts) => adopt(openSocket(index)).connect(opts)

/** Connect, send one HTTP request, resolve with the status line or reject. */
function httpStatus(socket, host, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    socket.once('connect', () =>
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    )
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(chunk.toString('latin1').split('\r\n')[0])
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function outcome(fn) {
  try {
    return { ok: true, detail: await fn() }
  } catch (error) {
    return { ok: false, detail: `${error.code ?? ''} ${error.message}` }
  }
}

/** Download `bytes` over HTTPS through the given raw socket; returns MB/s. */
function throughput(raw, address, bytes) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let received = 0
    const socket = tlsConnect({ socket: raw, servername: 'speed.cloudflare.com' })
    socket.once('secureConnect', () =>
      socket.write(
        `GET /__down?bytes=${bytes} HTTP/1.1\r\nHost: speed.cloudflare.com\r\nConnection: close\r\n\r\n`
      )
    )
    socket.on('data', (chunk) => (received += chunk.length))
    socket.once('end', () => {
      const seconds = (Date.now() - started) / 1000
      resolve(`${(received / 1e6 / seconds).toFixed(1)} MB/s (${received} bytes)`)
    })
    socket.once('error', reject)
    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, 60000)
  })
}

async function main() {
  console.log(`runtime: node ${process.versions.node}, electron ${process.versions.electron ?? '-'}, ${process.arch}`)
  tcp = await tcpHandleClass()
  console.log(`TCP handle class via ${tcp.via}`)

  const loopbackIndex = Number(
    ps("Get-NetIPInterface -AddressFamily IPv4 | ? InterfaceAlias -like 'Loopback*' | select -First 1 -Expand ifIndex")
  )
  const realIndex = Number(
    ps("Get-NetRoute -DestinationPrefix 0.0.0.0/0 | sort RouteMetric | select -First 1 -Expand ifIndex")
  )
  const realAddress = ps(
    `Get-NetIPAddress -InterfaceIndex ${realIndex} -AddressFamily IPv4 | select -First 1 -Expand IPAddress`
  )
  console.log({ loopbackIndex, realIndex, realAddress })

  // 1. Node accepts the raw socket at all (no option set), over loopback.
  const server = createServer((s) => s.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const localPort = server.address().port
  let r = await outcome(() => httpStatus(pinned(0, { host: '127.0.0.1', port: localPort }), 'local'))
  record('adopted socket, no option, loopback', true, r.ok, r.detail)

  // 2. Pinned to loopback, to a loopback server.
  r = await outcome(() =>
    httpStatus(pinned(loopbackIndex, { host: '127.0.0.1', port: localPort, localAddress: '127.0.0.1' }), 'local')
  )
  record('pinned to loopback, loopback server', true, r.ok, r.detail)
  server.close()

  // 3. Pinned to the real adapter, to the internet.
  r = await outcome(() =>
    httpStatus(pinned(realIndex, { host: '1.1.1.1', port: 80, localAddress: realAddress }), '1.1.1.1')
  )
  record('pinned to real adapter, internet', true, r.ok, r.detail)

  // 4. The proof the option is honoured: pinned to loopback, the internet must be unreachable,
  // while the same connect without the option works (5).
  r = await outcome(() => httpStatus(pinned(loopbackIndex, { host: '1.1.1.1', port: 80 }), '1.1.1.1', 5000))
  record('pinned to loopback, internet (must fail)', false, r.ok, r.detail)
  r = await outcome(() => httpStatus(pinned(0, { host: '1.1.1.1', port: 80 }), '1.1.1.1'))
  record('same socket without the option, internet', true, r.ok, r.detail)

  // 6. A bogus index is refused somewhere (setsockopt or connect), not silently ignored.
  r = await outcome(() => httpStatus(pinned(99999, { host: '1.1.1.1', port: 80 }), '1.1.1.1', 5000))
  record('bogus index 99999 (must fail)', false, r.ok, r.detail)

  // 7. Destroying a pinned socket mid-connect closes it cleanly (routes.ts cancels losers this way).
  r = await outcome(
    () =>
      new Promise((resolve, reject) => {
        const s = pinned(realIndex, { host: '10.255.255.1', port: 80 })
        s.once('connect', () => reject(new Error('unexpectedly connected')))
        s.once('close', () => resolve('closed'))
        setTimeout(() => s.destroy(), 300)
      })
  )
  record('destroy mid-connect closes', true, r.ok, r.detail)

  // 8. Throughput, pinned vs Node's own socket, over TLS (as real downloads are).
  const { address } = await lookup('speed.cloudflare.com', { family: 4 })
  const bytes = 50_000_000
  r = await outcome(() =>
    throughput(connect({ host: address, port: 443, localAddress: realAddress }), address, bytes)
  )
  record('throughput, plain Node socket', true, r.ok, r.detail)
  r = await outcome(() =>
    throughput(pinned(realIndex, { host: address, port: 443, localAddress: realAddress }), address, bytes)
  )
  record('throughput, pinned socket', true, r.ok, r.detail)

  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} as expected`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error('spike crashed:', error)
  process.exit(2)
})
