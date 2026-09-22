import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'
import { seededBytes, type Fault, type LoggedRequest } from './origin'

// B. A misbehaving server or network. The rule every case here must satisfy — enforced by the
// automatic checks in fixtures.ts — is that a download never ends `completed` with wrong bytes:
// it either retries its way to the exact file, or it errors and leaves nothing behind.

const SIZE = 16 * BLOCK

/** Faults a real server or network produces, applied to the first few chunk requests only. */
const TRANSIENT: [string, Fault][] = [
  ['Content-Range starts at the wrong byte', 'wrongStart'],
  ['body runs past the requested range', 'overlong'],
  ['206 without a Content-Range header', 'noContentRange'],
  ['200 (whole file) for a range that does not start at 0', 'ignoreRange'],
  ['416 Range Not Satisfiable', { status: 416 }],
  ['500 Internal Server Error', { status: 500 }],
  ['short body, then a clean end', { endAfter: 1000 }],
  ['connection reset partway through the body', { cutAfter: 5000 }],
  ['connection reset before any body', { cutAfter: 0 }],
  ['stall after the headers', 'stallBody'],
  ['stall before the headers', 'stallHeaders']
]

test.describe('transient server faults are retried to a correct file @smoke', () => {
  for (const [label, fault] of TRANSIENT) {
    test(label, async ({ plexo, serve }) => {
      const origin = await serve({ size: SIZE })
      let faulted = 0
      origin.setRule(({ range }) => (range && range.start > 0 && faulted++ < 3 ? fault : 'ok'))

      await plexo.start(origin.url(), origin.sha256, { connections: 2 })
      const state = await plexo.waitForStatus('completed')
      expect(faulted, 'the fault was actually injected').toBeGreaterThanOrEqual(3)
      expect(state.chunks.reduce((sum, chunk) => sum + chunk.retryCount, 0)).toBeGreaterThan(0)
    })
  }

  test('random connection resets across the whole file', async ({ plexo, serve }) => {
    const origin = await serve({ size: 48 * BLOCK, seed: 11 })
    let n = 0
    // Every third chunk request dies somewhere inside its block.
    origin.setRule(({ range }) =>
      range && range.start > 0 && n++ % 3 === 0 ? { cutAfter: (n * 7919) % BLOCK } : 'ok'
    )
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed')
  })
})

test.describe('a connection stuck at a crawl @smoke', () => {
  test.use({ appEnv: { PLEXO_E2E_SLOW_WARMUP_MS: '500', PLEXO_E2E_SLOW_FOR_MS: '1500' } })

  const BLOCKS = 48
  const tookFullBlock = (entry: LoggedRequest): boolean =>
    entry.bytesSent === entry.range!.end! - entry.range!.start + 1

  for (const [label, crawlStart] of [
    ['mid-download', BLOCK],
    ['on the last block (the 99% case)', (BLOCKS - 1) * BLOCK]
  ] as const) {
    test(`${label}: reconnected and resumed`, async ({ plexo, serve }) => {
      const origin = await serve({ size: BLOCKS * BLOCK, bytesPerSecond: 256 * 1024 })
      let crawled = false
      // 2 KB/s: this one block alone would take ~32 s.
      origin.setRule(({ range }) =>
        range?.start === crawlStart && !crawled ? ((crawled = true), { crawl: 2048 }) : 'ok'
      )

      await plexo.start(origin.url(), origin.sha256, { connections: 4 })
      const state = await plexo.waitForStatus('completed', 15_000)

      const requests = origin.chunkRequests()
      const slow = requests.find((entry) => typeof entry.fault === 'object')!
      expect(tookFullBlock(slow), 'the slow request was cut off').toBe(false)
      const resumed = requests.find(
        (entry) =>
          entry.n > slow.n &&
          entry.range!.start > slow.range!.start &&
          entry.range!.start <= slow.range!.end!
      )
      expect(resumed, 'the block resumed from where the slow connection stopped').toBeTruthy()
      expect(state.chunks.reduce((sum, chunk) => sum + chunk.retryCount, 0)).toBe(0)
    })
  }

  test('connections that are all equally slow are left alone', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCKS * BLOCK, bytesPerSecond: 256 * 1024 })
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed', 15_000)
    expect(origin.chunkRequests().every(tookFullBlock), 'no request was cut off').toBe(true)
  })

  test('a block is refreshed at most twice, then left to finish', async ({ plexo, serve }) => {
    const origin = await serve({ size: 3 * BLOCK })
    // Two fast blocks set the reference; every request for the third crawls.
    origin.setRule(({ range }) => (range && range.start >= 2 * BLOCK ? { crawl: 8192 } : 'ok'))

    await plexo.start(origin.url(), origin.sha256, { connections: 1 })
    await plexo.waitForStatus('completed', 30_000)
    const lastBlock = origin.chunkRequests().filter((entry) => entry.range!.start >= 2 * BLOCK)
    expect(lastBlock).toHaveLength(3)
  })
})

test.describe('servers without range support @smoke', () => {
  // With no ranges the only way to recover a dropped connection is to start the file over.
  for (const [label, contentLength] of [
    ['known size', true],
    ['unknown size', false]
  ] as const) {
    test(`a dropped connection restarts from the beginning (${label})`, async ({
      plexo,
      serve
    }) => {
      const origin = await serve({ size: 20 * BLOCK, ranges: false, contentLength })
      let transfers = 0
      origin.setRule(({ range }) =>
        range?.start === 0 && range.end === 0
          ? 'ok'
          : transfers++ === 0
            ? { cutAfter: 7 * BLOCK + 3 }
            : 'ok'
      )
      await plexo.start(origin.url(), origin.sha256)
      await plexo.waitForStatus('completed')
      expect(transfers, 'the second attempt fetched the whole file again').toBe(2)
    })
  }
})

test('one network dies for good mid-download; the other finishes it @smoke', async ({
  plexo,
  serve
}) => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
  const origin = await serve({ size: 40 * BLOCK })
  let fromB = 0
  // Network b serves two blocks, then every request over it fails.
  origin.setRule(({ from, range }) =>
    from !== '127.0.0.1' && range && !(range.start === 0 && range.end === 0) && fromB++ >= 2
      ? { status: 503 }
      : 'ok'
  )
  await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
  await plexo.waitForStatus('completed')
  const failedOverB = origin.log.filter(
    (entry) => entry.from !== '127.0.0.1' && entry.status === 503
  )
  expect(failedOverB.length, 'network b really did fail').toBeGreaterThan(0)
})

test.describe('permanent faults end in a clean error @smoke', () => {
  const PERMANENT: [string, Fault][] = [
    ['every chunk request fails with 500', { status: 500 }],
    ['every chunk request redirects to itself', { redirect: '/files/test.bin' }],
    ['every chunk request gets the wrong range', 'wrongStart']
  ]
  for (const [label, fault] of PERMANENT) {
    test(label, async ({ plexo, serve }) => {
      const origin = await serve({ size: SIZE })
      origin.setRule(({ range }) =>
        range && !(range.start === 0 && range.end === 0) ? fault : 'ok'
      )
      await plexo.start(origin.url(), origin.sha256, { connections: 2 })
      const state = await plexo.waitForStatus('error')
      expect(state.error).toBeTruthy()
    })
  }
})

test.describe('the file changes on the server mid-download @smoke', () => {
  const cases: [string, Omit<Parameters<typeof mutate>[0], 'origin'>][] = [
    ['same size, new ETag', { etag: '"v2"' }],
    ['same size, new Last-Modified (no ETag)', { lastModified: 'Thu, 02 Jan 2025 00:00:00 GMT' }],
    ['different size, no validators at all', { size: SIZE + BLOCK }]
  ]

  /** Republishes the file on the server, as a CDN rolling out a new version would. */
  function mutate({
    origin,
    etag,
    lastModified,
    size
  }: {
    origin: import('./origin').Origin
    etag?: string
    lastModified?: string
    size?: number
  }): void {
    origin.setContent(seededBytes(size ?? SIZE, 2), etag ?? origin.etag)
    if (lastModified) origin.lastModified = lastModified
  }

  for (const [label, change] of cases) {
    test(label, async ({ plexo, serve }) => {
      const origin = await serve({
        size: SIZE,
        seed: 1,
        etag: change.etag ? '"v1"' : null,
        lastModified: change.lastModified ? 'Wed, 01 Jan 2025 00:00:00 GMT' : null
      })
      const reached = origin.hold(3 * BLOCK + 100)
      await plexo.start(origin.url(), origin.sha256, { connections: 2 })
      await reached
      mutate({ origin, ...change })
      origin.release()

      // Never a file stitched from two versions: the download stops with a clear reason.
      const state = await plexo.waitForStatus(['completed', 'error'])
      expect(state.status).toBe('error')
      expect(state.error).toMatch(/changed during the download/)
    })
  }
})

test.describe('servers that label the same file differently @smoke', () => {
  // None of these is a changed file, so none may fail the download.
  test('load balancer: identical bytes, two different ETags', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE, etag: '"server-a"' })
    origin.setVersionRule(({ n }) =>
      n % 2 === 0 ? { content: origin.content, etag: '"server-b"' } : undefined
    )
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed')
    expect(origin.log.filter((entry) => entry.n % 2 === 0).length).toBeGreaterThan(0)
  })

  test('the same ETag, differing only by W/ or a -gzip suffix', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE, etag: '"v1"' })
    const variants = ['W/"v1"', '"v1-gzip"', '"v1"']
    origin.setVersionRule(({ n }) => ({ content: origin.content, etag: variants[n % 3] }))
    await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await plexo.waitForStatus('completed')
  })

  test('load balancer: identical bytes, Last-Modified differs per server (no ETag)', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({
      size: SIZE,
      etag: null,
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT'
    })
    // lastModified is shared, so alternate it from the rule instead.
    origin.setVersionRule(({ n }) => {
      origin.lastModified =
        n % 2 === 0 ? 'Wed, 01 Jan 2025 00:00:07 GMT' : 'Wed, 01 Jan 2025 00:00:00 GMT'
      return undefined
    })
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed')
  })

  test('half-rolled-out new version: some servers new, some old → error, never a mix', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE, seed: 1, etag: '"old"' })
    const next = seededBytes(SIZE, 2)
    origin.setVersionRule(({ n }) => (n % 2 === 0 ? { content: next, etag: '"new"' } : undefined))
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    const state = await plexo.waitForStatus(['completed', 'error'])
    expect(state.status).toBe('error')
    expect(state.error).toMatch(/changed during the download/)
  })
})
