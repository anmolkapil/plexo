import type { Locator, Page } from '@playwright/test'
import {
  LIMIT_SETTLE_MS,
  LimitReadout,
  limitedBy,
  type LimitFacts,
  type LimitedBy
} from '../src/shared/limitedBy'
import type { HttpDownloadNetwork, NetworkStatus } from '../src/shared/types'
import { describeLimit } from '../src/renderer/src/utils/limitedBy'
import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'
import { isProbe } from './origin'

// The line under TOTAL SPEED that says what holds a download back (shared/limitedBy.ts): one
// reason, the one the user can do most about first, and nothing while nothing does.

const KB = 1024

type Fact = LimitFacts['networks'][number]

const net = (id: string, status: NetworkStatus = 'on', over: Partial<Fact> = {}): Fact => ({
  id,
  enabled: status !== 'off',
  status,
  ...over
})

test.describe('which reason is said', () => {
  const healthy: LimitFacts = { networks: [net('wifi'), net('usb')] }

  test('nothing holding it back says nothing', () => {
    expect(limitedBy(healthy)).toBeUndefined()
    // A network the user switched off is their choice, not a limit.
    expect(limitedBy({ networks: [net('wifi'), net('usb', 'off')] })).toBeUndefined()
  })

  test('nothing carrying it says nothing: the screen says what it waits for instead', () => {
    expect(
      limitedBy({ cap: 'slow-mode', disk: true, networks: [net('wifi', 'limit')] })
    ).toBeUndefined()
    expect(limitedBy({ networks: [net('wifi', 'unreachable')] })).toBeUndefined()
  })

  test('the one the user can do most about comes first', () => {
    // Each fact on top of all the ones below it: the reasons in the order they are said.
    const layers: [Partial<LimitFacts> & { networks?: LimitFacts['networks'] }, LimitedBy][] = [
      [{ serverConnections: 4 }, { reason: 'server-connections', connections: 4 }],
      [{ oneConnection: true }, { reason: 'one-connection' }],
      [{ disk: true }, { reason: 'disk' }],
      [{ networks: [net('wifi'), net('usb', 'failed')] }, { reason: 'failed', network: 'usb' }],
      [
        { networks: [net('wifi'), net('usb', 'failed'), net('eth', 'unreachable')] },
        { reason: 'unreachable', network: 'eth' }
      ],
      [
        {
          networks: [
            net('wifi', 'on', { capped: true }),
            net('usb', 'failed'),
            net('eth', 'unreachable')
          ]
        },
        { reason: 'network-speed-limit', network: 'wifi' }
      ],
      [
        {
          networks: [
            net('wifi', 'on', { capped: true }),
            net('usb', 'limit'),
            net('eth', 'unreachable')
          ]
        },
        { reason: 'data-limit', network: 'usb' }
      ],
      [{ cap: 'speed-limit' }, { reason: 'speed-limit' }],
      [{ cap: 'slow-mode' }, { reason: 'slow-mode' }]
    ]
    let facts: LimitFacts = healthy
    for (const [fact, reason] of layers) {
      facts = { ...facts, ...fact }
      expect(limitedBy(facts), JSON.stringify(fact)).toEqual(reason)
    }
  })

  test('a reason holds a few seconds before the line changes to it, and back', () => {
    const readout = new LimitReadout()
    const disk: LimitedBy = { reason: 'disk' }
    expect(readout.update(disk, 0)).toBe(false)
    expect(readout.update(disk, LIMIT_SETTLE_MS - 1)).toBe(false)
    expect(readout.shown).toBeUndefined()
    expect(readout.update(disk, LIMIT_SETTLE_MS)).toBe(true)
    expect(readout.shown).toEqual(disk)
    // Coming and going from one look to the next never moves it.
    for (let now = LIMIT_SETTLE_MS; now < 4 * LIMIT_SETTLE_MS; now += 500) {
      expect(readout.update(now % 1000 ? undefined : disk, now)).toBe(false)
    }
    // Gone for good: cleared once that has held as long.
    const gone = 4 * LIMIT_SETTLE_MS
    expect(readout.update(undefined, gone)).toBe(false)
    expect(readout.update(undefined, gone + LIMIT_SETTLE_MS)).toBe(true)
    expect(readout.shown).toBeUndefined()
    // A change the user made is said at once.
    expect(readout.adopt({ reason: 'slow-mode' })).toBe(true)
    expect(readout.update({ reason: 'slow-mode' }, gone + LIMIT_SETTLE_MS + 1)).toBe(false)
  })
})

test.describe('how it is said', () => {
  const network = (
    id: string,
    label: string,
    status: NetworkStatus = 'on'
  ): HttpDownloadNetwork => ({
    transfer: 'http',
    id,
    label,
    kind: 'wifi',
    enabled: true,
    status,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    retries: 0
  })
  const http = (
    limit: LimitedBy,
    networks = [network('en0', 'Wi-Fi')]
  ): ReturnType<typeof describeLimit> => describeLimit({ kind: 'http', limitedBy: limit, networks })

  test('each reason in a few plain words, and where to change it when the user set it', () => {
    expect(describeLimit({ kind: 'http', networks: [] })).toBeNull()
    expect(http({ reason: 'slow-mode' })).toMatchObject({
      text: 'Limited by slow mode',
      limits: { page: null }
    })
    expect(http({ reason: 'speed-limit' })?.text).toBe('Limited by your speed limit')
    expect(http({ reason: 'data-limit', network: 'en0' })).toMatchObject({
      text: 'Wi-Fi reached its data limit',
      limits: { page: 'en0' }
    })
    expect(http({ reason: 'network-speed-limit', network: 'en0' })?.text).toBe(
      'Limited by Wi-Fi’s speed limit'
    )
    expect(http({ reason: 'unreachable', network: 'en0' })?.text).toBe(
      'Wi-Fi can’t reach this server'
    )
    expect(
      describeLimit({
        kind: 'torrent',
        limitedBy: { reason: 'unreachable', network: 'en0' },
        networks: []
      })?.text
    ).toBe('A network can’t reach any peers')
    // Refused, wrong answers, or nowhere to go: true of each, with its own error on hover.
    const failed = http({ reason: 'failed', network: 'en0' }, [
      { ...network('en0', 'Wi-Fi', 'failed'), error: 'Server replied 403' }
    ])
    expect(failed?.text).toBe('Wi-Fi isn’t used: it kept failing')
    expect(failed?.detail).toMatch(/\. Switch it off and on to try it again\.$/)
    const disk = http({ reason: 'disk' })
    expect(disk?.text).toBe('Limited by your drive')
    expect(disk?.limits).toBeUndefined()
  })

  test('the server’s limits say what that means for bonding', () => {
    const two = [network('en0', 'Wi-Fi'), network('en5', 'USB')]
    expect(http({ reason: 'one-connection' })?.text).toBe(
      'Limited by the server: it allows one connection'
    )
    expect(http({ reason: 'one-connection' }, two)?.text).toBe(
      'Only one network can be used for this download'
    )
    expect(http({ reason: 'server-connections', connections: 2 })?.text).toBe(
      'Limited by the server: it allows 2 connections'
    )
    expect(http({ reason: 'server-connections', connections: 1 }, two)?.text).toBe(
      'Limited by the server: it allows 1 connection per network'
    )
  })
})

test.describe('on the downloading screen', () => {
  const line = (page: Page): Locator => page.getByRole('status', { name: 'What limits the speed' })
  // Time for the reason to show up and settle, with room for a loaded machine.
  const SAID_MS = LIMIT_SETTLE_MS + 10_000

  async function open(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()
    await expect(page.getByText(/^TOTAL SPEED/)).toBeVisible()
  }

  test('a healthy download says nothing', async ({ plexo, serve }) => {
    // Slowed by the server for everyone alike: no limit of Plexo's, the drive keeps up, and the
    // server takes every connection. 8 MB at 512 KB/s runs about sixteen seconds.
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * KB })
    await plexo.start(origin.url(), origin.sha256)
    await open(plexo.page)
    // Past the time any reason would have taken to show, still downloading.
    const until = Date.now() + LIMIT_SETTLE_MS + 1500
    while (Date.now() < until) {
      await expect(line(plexo.page)).toHaveCount(0)
      await plexo.page.waitForTimeout(250)
    }
    expect((await plexo.current())?.status).toBe('downloading')
    expect(plexo.sessions.at(-1)!.filter((state) => state.limitedBy)).toEqual([])
    await plexo.waitForHttpStatus('completed', 30_000)
  })

  test('a server that turns extra connections away says how many it allows', async ({
    plexo,
    serve
  }) => {
    // As in streams.spec.ts: four connections served, the rest answered 503. 16 MB at 1 MB/s.
    const origin = await serve({ size: 256 * BLOCK, bytesPerSecond: 256 * KB })
    const accepted = new Set<number>()
    origin.setRule(({ connection, range }) => {
      if (isProbe(range)) return undefined
      if (accepted.has(connection) || accepted.size < 4) {
        accepted.add(connection)
        return undefined
      }
      return { status: 503 }
    })
    await plexo.start(origin.url(), origin.sha256, { connections: 'auto' })
    await open(plexo.page)
    await expect(line(plexo.page)).toHaveText('Limited by the server: it allows 4 connections', {
      timeout: SAID_MS
    })
    // Nothing for the user to change.
    await expect(line(plexo.page).getByRole('button', { name: 'Change' })).toHaveCount(0)
  })

  test('slow mode says so, and opens Speed & data limits', async ({ plexo, serve }) => {
    // 8 MB the server sends at 1 MB/s, held to 256 KB/s: slow mode is what holds it back.
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 512 * KB })
    await plexo.api.updateSettings({ slowMode: true, slowModeSpeed: 256 * KB })
    await plexo.start(origin.url(), origin.sha256)
    await open(plexo.page)
    await expect(line(plexo.page)).toContainText('Limited by slow mode', { timeout: SAID_MS })
    await line(plexo.page).getByRole('button', { name: 'Change' }).click()
    const dialog = plexo.page.getByRole('dialog', { name: 'Speed & data limits' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    // Switched off, it goes at once, rather than a few seconds later.
    await plexo.api.updateSettings({ slowMode: false })
    await expect(line(plexo.page)).toHaveCount(0, { timeout: LIMIT_SETTLE_MS - 1000 })
    expect((await plexo.current())?.status).toBe('downloading')
  })

  test('a server that sends the file in one piece says it takes one connection', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 32 * BLOCK, ranges: false, bytesPerSecond: 256 * KB })
    await plexo.start(origin.url(), origin.sha256)
    await open(plexo.page)
    await expect(line(plexo.page)).toHaveText(
      LAN_ADDRESS
        ? 'Only one network can be used for this download'
        : 'Limited by the server: it allows one connection',
      { timeout: SAID_MS }
    )
  })

  test('a network out of data says so while the other carries on', async ({ plexo, serve }) => {
    test.skip(!LAN_ADDRESS, 'needs a second network')
    const origin = await serve({ size: 64 * BLOCK, bytesPerSecond: 128 * KB })
    await plexo.api.updateSettings({
      networkPreferences: { a: { dataLimit: 4 * BLOCK, dataLimitPeriod: 'month' } }
    })
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'] })
    await open(plexo.page)
    await expect(line(plexo.page)).toContainText('a reached its data limit', { timeout: SAID_MS })
    await line(plexo.page).getByRole('button', { name: 'Change' }).click()
    await expect(plexo.page.getByRole('dialog', { name: 'Speed & data limits' })).toBeVisible()
  })
})
