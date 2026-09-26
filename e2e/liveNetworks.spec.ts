import {
  BLOCK,
  expect,
  interfacesEnv,
  LAN_ADDRESS,
  NETWORKS,
  test,
  type PlexoApp
} from './fixtures'
import type { LoggedRequest } from './origin'
import type { DownloadState } from '../src/shared/types'

// O. Networks that come, go, and are switched on and off while a download runs.

/** What the computer's networks are now, as the app will see them at its next look. */
const setNetworks = (plexo: PlexoApp, networks: Record<string, string>): Promise<void> =>
  plexo.evaluateMain((_electron, value) => {
    process.env['PLEXO_E2E_INTERFACES'] = value
  }, interfacesEnv(networks))

const overB = (request: Pick<LoggedRequest, 'from'>): boolean => request.from !== '127.0.0.1'
const network = (state: DownloadState, id: string): DownloadState['networks'][number] | undefined =>
  state.networks.find((entry) => entry.id === id)
const streamsOn = (state: DownloadState, id: string): number =>
  state.chunks.filter((chunk) => chunk.interfaceId === id).length
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('the only network drops for a while: the download waits, then picks up where it was @smoke', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: 64 * BLOCK, bytesPerSecond: 256 * 1024 })
  await plexo.start(origin.url(), origin.sha256)
  await plexo.waitUntil((state) => state.bytesDownloaded > 0)

  await setNetworks(plexo, {})
  await plexo.waitUntil((state) => network(state, 'a')?.status === 'offline')
  const gone = (await plexo.current())!
  // Far longer than a stream's retries used to last before the download failed and its
  // progress was thrown away (five of them, 20 ms apart and doubling, in these tests).
  await settle(1500)
  const waited = (await plexo.current())!
  expect(waited.status).toBe('downloading')
  expect(waited.chunks).toHaveLength(0)
  expect(waited.bytesDownloaded, 'nothing it had was lost').toBe(gone.bytesDownloaded)

  await setNetworks(plexo, { a: NETWORKS['a'] })
  await plexo.waitForStatus('completed')
})

test.describe('two networks @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('a network that drops out and comes back is used again', async ({ plexo, serve }) => {
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    await plexo.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0)

    await setNetworks(plexo, { a: NETWORKS['a'] })
    const gone = await plexo.waitUntil(
      (state) => network(state, 'b')?.status === 'offline' && streamsOn(state, 'b') === 0
    )
    expect(network(gone, 'b')?.enabled, 'still the user’s pick').toBe(true)
    const goneAt = origin.log.length

    await setNetworks(plexo, NETWORKS)
    await plexo.waitForStatus('completed')
    expect(origin.log.slice(goneAt).some(overB), 'b carried more once it was back').toBe(true)
  })

  test('a network that turns up mid-download is listed off; it carries traffic only while switched on', async ({
    plexo,
    serve
  }) => {
    await setNetworks(plexo, { a: NETWORKS['a'] })
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await plexo.waitUntil((state) => state.bytesDownloaded > 0)
    expect(network((await plexo.current())!, 'b')).toBeUndefined()

    await setNetworks(plexo, NETWORKS)
    const listed = await plexo.waitUntil((state) => network(state, 'b') !== undefined)
    expect(network(listed, 'b')).toMatchObject({ enabled: false, status: 'off' })
    await settle(500)
    expect(origin.chunkRequests().some(overB), 'not used until switched on').toBe(false)

    await plexo.api.setDownloadNetwork(id, 'b', true)
    await plexo.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0)

    await plexo.api.setDownloadNetwork(id, 'b', false)
    const off = await plexo.waitUntil((state) => streamsOn(state, 'b') === 0)
    expect(network(off, 'b')).toMatchObject({ enabled: false, status: 'off' })
    expect(network(off, 'b')!.bytesDownloaded, 'what it delivered stays its own').toBeGreaterThan(0)
    const offAt = origin.log.length

    // The last network in use can't be switched off: pausing is how a download stops.
    await plexo.api.setDownloadNetwork(id, 'a', false)
    expect(network((await plexo.current())!, 'a')?.enabled).toBe(true)

    await settle(500)
    expect(origin.log.slice(offAt).some(overB), 'nothing over b while it is off').toBe(false)
  })
})

test.describe('a network that can’t reach the server @smoke', () => {
  test.use({ appEnv: { PLEXO_E2E_SILENT_MS: '500' } })

  test('keeps one stream trying, and gets its streams back once it is through', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: 128 * BLOCK, bytesPerSecond: 256 * 1024 })
    let blocked = true
    // Every connection over b drops before a byte of the file: connected, but not getting through.
    origin.setRule((request) =>
      blocked && overB(request) && request.range && request.range.end !== 0 ? { cutAfter: 0 } : 'ok'
    )
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })

    const cut = await plexo.waitUntil(
      (state) => network(state, 'b')?.status === 'unreachable' && streamsOn(state, 'b') === 1
    )
    expect(network(cut, 'b')?.enabled).toBe(true)
    expect(cut.status, 'the download carries on over a').toBe('downloading')

    blocked = false
    await plexo.waitUntil(
      (state) => network(state, 'b')?.status === 'on' && streamsOn(state, 'b') === 2
    )
    await plexo.waitForStatus('completed')
    expect(network((await plexo.current())!, 'b')!.bytesDownloaded).toBeGreaterThan(0)
  })
})

test.describe('a network that changes address', () => {
  // Far longer than the test waits: a stream only retries in time if it is woken.
  test.use({ appEnv: { PLEXO_E2E_RETRY_BASE_MS: '10000' } })

  test('gets its streams going again at once, not when their backoff runs out @smoke', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: 192 * BLOCK, bytesPerSecond: 256 * 1024 })
    // Every connection over b's first address drops before a byte of the file.
    origin.setRule((request) =>
      overB(request) && request.range && request.range.end !== 0 ? { cutAfter: 0 } : 'ok'
    )
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    await plexo.waitUntil((state) =>
      state.chunks.some((chunk) => chunk.interfaceId === 'b' && chunk.status === 'retrying')
    )

    // A new DHCP lease, say: b is now reached at another address, which gets through.
    await setNetworks(plexo, { a: NETWORKS['a'], b: '127.0.0.1' })
    const changedAt = Date.now()
    await plexo.waitUntil((state) => (network(state, 'b')?.bytesDownloaded ?? 0) > 0, 5000)
    expect(Date.now() - changedAt, 'well before a backoff of 8 s or more').toBeLessThan(5000)
  })
})

test.describe('the computer wakes from sleep', () => {
  // Nothing else would notice the dead connection for a long while.
  test.use({ appEnv: { PLEXO_E2E_STALL_MS: '60000', PLEXO_E2E_SILENT_MS: '60000' } })

  test('a connection that died in its sleep is replaced at once @smoke', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 16 * BLOCK })
    let stalled = 0
    // One block's answer stops after its headers, as a connection does across a sleep.
    origin.setRule(({ range }) =>
      range?.start === 3 * BLOCK && stalled++ === 0 ? 'stallBody' : 'ok'
    )
    await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await plexo.waitUntil((state) => state.bytesDownloaded >= 15 * BLOCK)
    expect((await plexo.current())!.status).toBe('downloading')

    await plexo.evaluateMain((electron) => {
      electron.powerMonitor.emit('resume')
    }, null)
    await plexo.waitForStatus('completed', 5000)
    expect(stalled, 'the block was asked for again').toBeGreaterThan(1)
  })
})
