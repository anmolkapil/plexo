import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, connect, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { connectRouteAsync } from '../src/main/network/deviceBinding'

test.skip(process.platform !== 'win32', 'Windows-only Winsock helper integration')

const exe = join(process.cwd(), 'PlexoWinRoute', 'publish', 'win-x64', 'PlexoWinRoute.exe')

test('rejects invalid tokens and headers, then shuts down when stdin closes', async () => {
  expect(existsSync(exe), 'Publish the helper before running this test').toBe(true)
  const token = randomBytes(32).toString('hex')
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Helper did not become ready')), 15000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const match = /READY (\d+)/.exec(output)
        if (match) {
          clearTimeout(timer)
          resolve(Number(match[1]))
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Helper exited before READY'))
      })
      child.stdin.write(token + '\n')
    })

    const refused = async (header: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1')
        const timer = setTimeout(() => {
          socket.destroy()
          reject(new Error('Helper did not reject the request'))
        }, 5000)
        socket.once('connect', () => socket.write(header + '\n'))
        socket.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        socket.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    await refused(JSON.stringify({
      token: 'not-the-session-token',
      remoteAddress: '127.0.0.1',
      remotePort: 80,
      localAddress: '127.0.0.1',
      interfaceIndex: 1
    }))
    await refused('{not valid json}')
    expect(child.exitCode).toBeNull()

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('Helper survived closed stdin'))
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.stdin.end()
    })
  } finally {
    child.kill()
  }
})

test('falls back to an ordinary socket when there is no adapter index', async () => {
  const adapter = Object.values(networkInterfaces())
    .flat()
    .find((address) => address && !address.internal && address.family === 'IPv4')
  test.skip(!adapter, 'No physical IPv4 adapter on this runner')
  const local = adapter!.address
  const server = createServer((socket) => socket.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  let socket: Socket | undefined
  try {
    const port = (server.address() as { port: number }).port
    socket = await connectRouteAsync({
      device: 'test',
      localAddress: local,
      remoteAddress: local,
      family: 4
    }, port)
    const data = await new Promise<string>((resolve, reject) => {
      let body = ''
      socket!.on('data', (chunk: Buffer) => { body += chunk.toString() })
      socket!.on('end', () => resolve(body))
      socket!.on('error', reject)
    })
    expect(data).toBe('ok')
  } finally {
    socket?.destroy()
    server.close()
  }
})
