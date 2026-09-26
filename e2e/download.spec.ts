import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'

// A. Downloads that should simply work. Every test also runs the automatic checks in
// fixtures.ts: completed ⇒ the file's SHA-256 matches the source, nothing stray left behind.

test.describe('happy paths @smoke', () => {
  test('IPv6-only origin downloads through an IPv6 interface', async ({ plexo, serve }) => {
    const origin = await serve({ size: 4 * BLOCK, host: '::1' })
    await plexo.relaunch({ PLEXO_E2E_INTERFACES: 'a=::1' })
    await plexo.start(origin.url(), origin.sha256)
    const state = await plexo.waitForStatus('completed')
    expect(state.networks.every((network) => network.retries === 0)).toBe(true)
    expect(origin.chunkRequests().every((request) => request.from === '::1')).toBe(true)
  })

  test('IPv6 origin reports an incompatible IPv4-only selection immediately', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCK, host: '::1' })
    await expect(plexo.start(origin.url(), origin.sha256)).rejects.toThrow(/No selected network/)
    expect(await plexo.current()).toBeNull()
  })

  for (const [label, size] of [
    ['1 byte', 1],
    ['37.5 blocks', Math.floor(BLOCK * 37.5)]
  ] as const) {
    test(`ranged download: ${label}`, async ({ plexo, serve }) => {
      const origin = await serve({ size })
      await plexo.start(origin.url(), origin.sha256, { connections: 4 })
      const state = await plexo.waitForStatus('completed')
      expect(state.bytesDownloaded).toBe(size)
      expect(state.totalBlocks).toBe(Math.ceil(size / BLOCK))
    })
  }

  test('each stream keeps its connection from one block to the next', async ({ plexo, serve }) => {
    const origin = await serve({ size: 20 * BLOCK + 123 })
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    const state = await plexo.waitForStatus('completed')
    expect(state.chunks).toHaveLength(4)
    const requests = origin.chunkRequests()
    expect(new Set(requests.map((request) => request.connection)).size).toBe(4)
    expect(requests.length).toBeGreaterThan(4)
  })

  test('two networks share the work, and attribution matches what the server saw', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: 40 * BLOCK })
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    const state = await plexo.waitForStatus('completed')

    const served = { a: 0, b: 0 }
    for (const entry of origin.chunkRequests()) {
      served[entry.from === '127.0.0.1' ? 'a' : 'b'] += entry.bytesSent
    }
    const attributed = { a: 0, b: 0 }
    for (const block of state.blocks ?? []) {
      attributed.a += block.bytesByInterface['a'] ?? 0
      attributed.b += block.bytesByInterface['b'] ?? 0
    }
    expect(served.a, 'network a carried some of the file').toBeGreaterThan(0)
    expect(served.b, 'network b carried some of the file').toBeGreaterThan(0)
    expect(attributed).toEqual(served)
  })

  test('after the first, updates carry only the blocks that changed', async ({ plexo, serve }) => {
    const origin = await serve({ size: 64 * BLOCK, bytesPerSecond: 500_000 })
    const id = await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForStatus('completed')
    const sent = plexo.updates.at(-1)!.filter((update) => update.state.id === id)
    expect(sent.length, 'progress kept coming while it downloaded').toBeGreaterThan(5)
    expect(sent[0].blocks).toHaveLength(64)
    // Two streams move a few blocks between one update and the next, not all 64.
    expect(Math.max(...sent.slice(1).map((update) => update.blocks.length))).toBeLessThan(16)
  })

  test('server without range support: one stream, whole file', async ({ plexo, serve }) => {
    const origin = await serve({ size: 10 * BLOCK, ranges: false })
    await plexo.start(origin.url(), origin.sha256)
    const state = await plexo.waitForStatus('completed')
    expect(state.chunks).toHaveLength(1)
  })

  test('unknown size (no Content-Length)', async ({ plexo, serve }) => {
    const origin = await serve({ size: 10 * BLOCK, ranges: false, contentLength: false })
    await plexo.start(origin.url(), origin.sha256)
    const state = await plexo.waitForStatus('completed')
    expect(state.totalBytes).toBe(0)
  })

  test('redirect during probe and on chunk requests', async ({ plexo, serve }) => {
    const origin = await serve({ size: 12 * BLOCK })
    origin.setRule(({ path }) => (path === '/start' ? { redirect: '/files/test.bin' } : 'ok'))
    await plexo.start(origin.url('/start'), origin.sha256)
    await plexo.waitForStatus('completed')

    // The chunk requests follow redirects too (a signed CDN URL rotating mid-download).
    const next = await serve({ size: 12 * BLOCK, seed: 7 })
    let redirected = 0
    next.setRule(({ path, range }) => {
      if (path === '/files/test.bin' && range && range.start > 0 && redirected++ < 3) {
        return { redirect: '/files/moved.bin' }
      }
      return 'ok'
    })
    await plexo.start(next.url(), next.sha256)
    await plexo.waitForStatus('completed')
    expect(redirected).toBeGreaterThan(0)
  })
})

test.describe('file names @smoke', () => {
  const cases: [string, string, RegExp][] = [
    ['path traversal is flattened', 'attachment; filename="../../evil.sh"', /^\.\._\.\._evil\.sh$/],
    ['control characters are replaced', 'attachment; filename="a%0Ab.txt"', /^a_b\.txt$/]
  ]
  for (const [label, disposition, expected] of cases) {
    test(label, async ({ plexo, serve, dirs }) => {
      const origin = await serve({ size: 3 * BLOCK, contentDisposition: disposition })
      await plexo.start(origin.url(), origin.sha256)
      const state = await plexo.waitForStatus('completed')
      expect(state.fileName).toMatch(expected)
      expect(state.destinationPath.startsWith(dirs.dest)).toBe(true)
    })
  }

  test('the same name twice gets "(1)" and leaves the first file alone', async ({
    plexo,
    serve
  }) => {
    const first = await serve({ size: 3 * BLOCK, seed: 1 })
    await plexo.start(first.url(), first.sha256)
    const one = await plexo.waitForStatus('completed')

    const second = await serve({ size: 5 * BLOCK, seed: 2 })
    await plexo.start(second.url(), second.sha256)
    const two = await plexo.waitForStatus('completed')

    expect(one.fileName).toBe('test.bin')
    expect(two.fileName).toBe('test (1).bin')
    const { readFile } = await import('node:fs/promises')
    const { sha256 } = await import('./origin')
    expect(sha256(await readFile(one.destinationPath))).toBe(first.sha256)
  })
})

test.describe('edge cases', () => {
  test('a 0-byte file @smoke', async ({ plexo, serve }) => {
    const origin = await serve({ size: 0 })
    await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForStatus('completed', 5000)
  })

  test('a server that never answers the link check → an error, not endless "Checking…" @smoke', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCK })
    origin.setRule(() => 'stallHeaders')
    const started = Date.now()
    await expect(plexo.api.probeUrl(origin.url())).rejects.toThrow(/did not respond/)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('starting a second download while one is active is refused @smoke', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 10 * BLOCK })
    const reached = origin.hold(BLOCK)
    await plexo.start(origin.url(), origin.sha256)
    await reached

    const other = await serve({ size: BLOCK, seed: 3 })
    await expect(plexo.start(other.url(), other.sha256)).rejects.toThrow(/already in progress/)

    origin.release()
    await plexo.waitForStatus('completed')
  })
})
