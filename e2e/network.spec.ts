import { expect, test } from '@playwright/test'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { NetworkInterfaceInfo } from '../src/shared/types'
import { StreamConnection } from '../src/main/network/routes'

const iface: NetworkInterfaceInfo = {
  id: 'wifi',
  device: 'wifi',
  displayName: 'Wi-Fi',
  kind: 'wifi',
  addresses: [
    { address: '192.0.2.2', family: 4 },
    { address: '2001:db8::2', family: 6 }
  ]
}

const loopback: NetworkInterfaceInfo = {
  ...iface,
  addresses: [{ address: '127.0.0.1', family: 4 }]
}

async function body(res: IncomingMessage): Promise<string> {
  let text = ''
  for await (const chunk of res) text += chunk
  return text
}

test('AAAA-only hostname connects over IPv6 and keeps its HTTP Host header @smoke', async () => {
  let seenHost = ''
  const server = createServer((req, res) => {
    seenHost = req.headers.host ?? ''
    res.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
  const connection = new StreamConnection(
    () => ({ ...iface, addresses: [{ address: '::1', family: 6 }] }),
    { timeoutMs: 2000, resolveHost: async () => [{ address: '::1', family: 6 }] }
  )
  try {
    const port = (server.address() as AddressInfo).port
    const { res } = await connection.request(new URL(`http://ipv6.example.test:${port}/file`), {})
    expect(await body(res)).toBe('ok')
    expect(seenHost).toBe(`ipv6.example.test:${port}`)
  } finally {
    connection.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a working route gets time to answer after an earlier route fails @smoke', async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => res.end('ipv6'), 1800)
  })
  await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
  const connection = new StreamConnection(
    () => ({
      ...iface,
      addresses: [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 }
      ]
    }),
    {
      timeoutMs: 3000,
      resolveHost: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
        { address: '127.0.0.2', family: 4 }
      ]
    }
  )
  try {
    const port = (server.address() as AddressInfo).port
    const { res } = await connection.request(new URL(`http://dual.example.test:${port}/`), {})
    expect(await body(res)).toBe('ipv6')
  } finally {
    connection.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('DNS resolution obeys the request deadline @smoke', async () => {
  const connection = new StreamConnection(() => iface, {
    timeoutMs: 100,
    resolveHost: () => new Promise(() => {})
  })
  await expect(
    connection.request(new URL('http://unresolved.example.test/file'), {})
  ).rejects.toThrow('Could not resolve the download host in time')
  connection.close()
})

test('a kept-alive connection the server dropped is replaced without failing the request @smoke', async () => {
  let requests = 0
  let connections = 0
  // The second request lands on the reused connection and is dropped unanswered, as happens when
  // a server times out an idle connection just as the next request goes out.
  const server = createServer((req, res) => {
    if (++requests === 2) req.socket.destroy()
    else res.end(`answer ${requests}`)
  })
  server.on('connection', () => connections++)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connection = new StreamConnection(() => loopback, { timeoutMs: 2000 })
  try {
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    expect(await body((await connection.request(url, {})).res)).toBe('answer 1')
    expect(await body((await connection.request(url, {})).res)).toBe('answer 3')
    expect(connections).toBe(2)
  } finally {
    connection.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a request abandoned while still connecting gives up the connection with it @smoke', async () => {
  // DNS that never answers stands in for any connect that hangs: the abort has to end it, not the
  // deadline.
  const connection = new StreamConnection(() => iface, {
    timeoutMs: 5000,
    resolveHost: () => new Promise(() => {})
  })
  const abort = new AbortController()
  const started = Date.now()
  setTimeout(() => abort.abort(), 100)
  await expect(
    connection.request(new URL('http://slow.example.test/'), {}, abort.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(Date.now() - started).toBeLessThan(1000)
  connection.close()
})

test('a network that comes back with a new address is reached at that one @smoke', async () => {
  const server = createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Gone, and then back: every new socket asks for the network as it is now.
  let current: NetworkInterfaceInfo | undefined
  const connection = new StreamConnection(() => current, { timeoutMs: 2000 })
  try {
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    await expect(connection.request(url, {})).rejects.toThrow(/not connected/)
    current = loopback
    const { res } = await connection.request(url, {})
    expect(await body(res)).toBe('ok')
  } finally {
    connection.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('reconnect drops its sockets, and the next request opens a new one @smoke', async () => {
  let connections = 0
  const server = createServer((_req, res) => res.end('ok'))
  server.on('connection', () => connections++)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const connection = new StreamConnection(() => loopback, { timeoutMs: 2000 })
  try {
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
    expect(await body((await connection.request(url, {})).res)).toBe('ok')
    expect(await body((await connection.request(url, {})).res)).toBe('ok')
    expect(connections, 'kept alive until then').toBe(1)
    connection.reconnect()
    expect(await body((await connection.request(url, {})).res)).toBe('ok')
    expect(connections).toBe(2)
  } finally {
    connection.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
