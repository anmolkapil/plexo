import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'

// A. Downloads that should simply work. Every test also runs the automatic checks in
// fixtures.ts: completed ⇒ the file's SHA-256 matches the source, nothing stray left behind.

test.describe('happy paths @smoke', () => {
  for (const [label, size] of [
    ['1 byte', 1],
    ['exactly one block', BLOCK],
    ['one block plus one byte', BLOCK + 1],
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

  for (const connections of [1, 8]) {
    test(`${connections} connection(s) per network`, async ({ plexo, serve }) => {
      const origin = await serve({ size: 20 * BLOCK + 123 })
      await plexo.start(origin.url(), origin.sha256, { connections })
      const state = await plexo.waitForStatus('completed')
      expect(state.chunks).toHaveLength(connections)
    })
  }

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
    ['Content-Disposition name', 'attachment; filename="report.pdf"', /^report\.pdf$/],
    ['RFC 5987 filename*', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt", /^résumé\.txt$/],
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

  test('a malformed %-escape in the URL path still downloads', async ({ plexo, serve }) => {
    const origin = await serve({ size: 2 * BLOCK })
    await plexo.start(origin.url('/files/100%25%E0%A4%A.bin'), origin.sha256)
    await plexo.waitForStatus('completed')
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

test.describe('a network that never answers', () => {
  // The stall timeout is far longer than the test, so only noticing the silence can save it.
  test.use({ appEnv: { PLEXO_E2E_STALL_MS: '30000', PLEXO_E2E_SILENT_MS: '300' } })

  test('does not hold up a download the other network can finish', async ({ plexo, serve }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: 24 * BLOCK })
    origin.setRule(({ from, range }) =>
      from !== '127.0.0.1' && !(range?.start === 0 && range.end === 0) ? 'stallHeaders' : 'ok'
    )

    const started = Date.now()
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    const state = await plexo.waitForStatus('completed', 15_000)

    expect(Date.now() - started).toBeLessThan(15_000)
    const deliveredByB = (state.blocks ?? []).reduce(
      (sum, block) => sum + (block.bytesByInterface['b'] ?? 0),
      0
    )
    expect(deliveredByB, 'the silent network delivered nothing').toBe(0)
  })
})
