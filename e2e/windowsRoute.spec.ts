import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

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

test('selects loopback interface from source IP without an InterfaceIndex', async () => {
  expect(existsSync(exe), 'Publish the helper before running this test').toBe(true)
  const token = randomBytes(32).toString('hex')
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const server = createServer((socket) => socket.end('hello'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const ready = new Promise<number>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Helper startup timed out')), 15000)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = /READY (\d+)/.exec(output)
        if (!match) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      })
      child.once('error', reject)
    })
    child.stdin.write(token + '\n')
    const helperPort = await ready

    const open = async (localAddress: string): Promise<string> => {
      const socket = connect(helperPort, '127.0.0.1')
      try {
        return await new Promise<string>((resolve, reject) => {
          let data = ''
          const timer = setTimeout(() => {
            socket.destroy()
            reject(new Error('Helper tunnel timed out'))
          }, 5000)
          socket.once('connect', () => {
            socket.write(JSON.stringify({
              token,
              remoteAddress: '127.0.0.1',
              remotePort: (server.address() as { port: number }).port,
              localAddress
            }) + '\n')
          })
          socket.on('data', (chunk: Buffer) => {
            data += chunk.toString()
            if (data.includes('\n')) {
              clearTimeout(timer)
              resolve(data)
            }
          })
          socket.once('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
        })
      } finally {
        socket.destroy()
      }
    }

    // The helper must discover an actual interface index without an InterfaceIndex field.
    expect(await open('127.0.0.1')).toMatch(/^OK \d+\n/)
    // A non-local source IP must fail clearly, without terminating the helper process.
    expect(await open('192.0.2.201')).toBe('ERR ENODEV\n')
    expect(child.exitCode).toBeNull()
  } finally {
    server.close()
    child.stdin.end()
    child.kill()
  }
})
