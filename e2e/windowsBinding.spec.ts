import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import type { Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { expect, test } from '@playwright/test'
import {
  connectFrom,
  connectRoute,
  deviceBindingSupported
} from '../src/main/network/deviceBinding'

const host = '1.1.1.1'
const port = 80

test.describe('Windows adapter pinning', () => {
  test.skip(process.platform !== 'win32', 'Winsock only')

  let loopback: string
  let defaultDevice: string
  const dial = (device: string): Socket =>
    connectRoute({ device, family: 4, remoteAddress: host, localAddress: '0.0.0.0' }, port)

  test.beforeAll(async () => {
    // A failed probe falls back to plain localAddress, which would make every test below
    // meaningless, so it must pass here.
    expect(await deviceBindingSupported()).toBe(true)

    const interfaces = Object.entries(networkInterfaces())
    const alias = (address: string): string => {
      const match = interfaces.find(([, addresses]) =>
        addresses?.some((ip) => ip.address === address)
      )
      if (!match) throw new Error(`No adapter owns ${address}`)
      return match[0]
    }
    // Ask the kernel which source it would use for this destination without sending a packet.
    const udp = createSocket('udp4')
    try {
      udp.connect(port, host)
      await once(udp, 'connect')
      defaultDevice = alias(udp.address().address)
    } finally {
      udp.close()
    }
    loopback = alias('127.0.0.1')
  })

  test('a connection pinned to loopback cannot reach the internet', async () => {
    const [error] = await once(dial(loopback), 'error')
    expect(error).toMatchObject({ code: 'ENETUNREACH' })
  })

  test('the same connection pinned to the default adapter gets through', async () => {
    const socket = dial(defaultDevice)
    try {
      await once(socket, 'connect')
    } finally {
      socket.destroy()
    }
  })

  test('an adapter that does not exist fails the connection, not the caller', async () => {
    const socket = connectFrom(undefined, host, port, 'Plexo nonexistent test adapter')
    const [error] = await once(socket, 'error')
    expect(error.message).toContain('Plexo nonexistent test adapter')
  })

  test('a pinned connection cancelled mid-connect closes cleanly', async () => {
    const socket = dial(defaultDevice)
    expect(socket.connecting).toBe(true)
    const closed = once(socket, 'close')
    socket.destroy()
    expect(await closed).toEqual([false])
  })

  test('failed and cancelled connections leave pinning working', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await once(dial(loopback), 'error')
      const pending = dial(defaultDevice)
      const closed = once(pending, 'close')
      pending.destroy()
      await closed
    }
    const socket = dial(defaultDevice)
    try {
      await once(socket, 'connect')
    } finally {
      socket.destroy()
    }
  })
})
