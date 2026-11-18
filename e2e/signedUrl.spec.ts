import { describeError } from '../src/shared/errors'
import { BLOCK, expect, test } from './fixtures'
import { isProbe, type Origin } from './origin'

// A link like huggingface.co/…/resolve/… or an S3 presigned one redirects to a signed CDN URL that
// stops working later (HF's CloudFront `Expires` is +1 h), while the link itself keeps redirecting
// to a fresh one. Once the signed URL is turned away, the download asks the link it was given for
// a fresh one, checks it as Fix does, and goes on with it (#160).

const SIZE = 64 * BLOCK

/** /start redirects to the current signature. `expire()` makes the first one answer 403 and
 * /start point at a second one, or, `dead`, answer 410 itself. */
function signedLink(origin: Origin, dead = false): { expire: () => void } {
  let expired = false
  origin.setRule(({ path, range }) => {
    if (path === '/start') {
      if (expired && dead) return { status: 410 }
      return { redirect: `/files/test.bin?sig=${expired ? 2 : 1}` }
    }
    if (expired && path === '/files/test.bin?sig=1' && !isProbe(range)) return { status: 403 }
    return 'ok'
  })
  return { expire: () => (expired = true) }
}

const startRequests = (origin: Origin): number =>
  origin.log.filter((entry) => entry.path === '/start').length

test('a signed URL that expires mid-download is refreshed from the link it came from', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: SIZE, bytesPerSecond: 512 * 1024 })
  const link = signedLink(origin)
  await plexo.start(origin.url('/start'), origin.sha256, { connections: 2 })
  await plexo.waitUntil((state) => state.bytesDownloaded > 4 * BLOCK, 20_000)
  link.expire()

  const done = await plexo.waitForHttpStatus(['completed', 'error'], 60_000)
  expect(done.status).toBe('completed')
  expect(done.url).toBe(origin.url('/files/test.bin?sig=2'))
  expect(done.requestedUrl).toBe(origin.url('/start'))
  // The probe that started it, and one for the fresh link: every stream waited on the same one.
  expect(startRequests(origin)).toBe(2)
})

test('a signed URL that expired while paused is refreshed on resume', async ({ plexo, serve }) => {
  const origin = await serve({ size: SIZE, bytesPerSecond: 512 * 1024 })
  const link = signedLink(origin)
  const id = await plexo.start(origin.url('/start'), origin.sha256, { connections: 2 })
  await plexo.waitUntil((state) => state.bytesDownloaded > 4 * BLOCK, 20_000)
  await plexo.api.pauseDownload(id)
  await plexo.waitForStatus('paused')
  link.expire() // paused for longer than the signature lasts
  await plexo.api.resumeDownload(id)

  const done = await plexo.waitForHttpStatus(['completed', 'error'], 60_000)
  expect(done.status).toBe('completed')
  expect(done.url).toBe(origin.url('/files/test.bin?sig=2'))
  expect(startRequests(origin)).toBe(2)
})

test('the link it came from is kept across a relaunch', async ({ plexo, serve }) => {
  const origin = await serve({ size: SIZE, bytesPerSecond: 512 * 1024 })
  const link = signedLink(origin)
  const id = await plexo.start(origin.url('/start'), origin.sha256, { connections: 2 })
  await plexo.waitUntil((state) => state.bytesDownloaded > 4 * BLOCK, 20_000)
  await plexo.quit()
  link.expire()
  await plexo.launch()

  expect((await plexo.currentHttp())?.status).toBe('paused')
  await plexo.api.resumeDownload(id)
  expect((await plexo.waitForHttpStatus(['completed', 'error'], 60_000)).status).toBe('completed')
  expect(startRequests(origin)).toBe(2)
})

test('a link that no longer works itself still fails the download, asked once', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: SIZE, bytesPerSecond: 512 * 1024 })
  const link = signedLink(origin, true)
  await plexo.start(origin.url('/start'), origin.sha256, { connections: 2 })
  await plexo.waitUntil((state) => state.bytesDownloaded > 4 * BLOCK, 20_000)
  link.expire()

  const failed = await plexo.waitForHttpStatus(['completed', 'error'], 60_000)
  expect(failed.status).toBe('error')
  expect(describeError(failed.error)).toBe(
    'This link no longer works. Paste a new link to continue.'
  )
  expect(failed.url).toBe(origin.url('/files/test.bin?sig=1'))
  expect(startRequests(origin)).toBe(2)
})

// At the end of a download, free streams split the last block (see scheduler.ts). The signed URL
// running out just as one of them asks for its part: the holder, cut short at the split, carries
// on with the response it already has, and the part is fetched again from the fresh URL, once.
test.describe('a signed URL that expires while the last block is split', () => {
  const MIB = 1024 * 1024
  const SPLIT_SIZE = 5 * MIB
  const LAST = 4 * MIB
  test.use({ appEnv: { PLEXO_E2E_BLOCK_BYTES: String(MIB), PLEXO_E2E_SILENT_MS: '1000' } })

  test('the split part is fetched from the fresh URL, and nothing twice', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SPLIT_SIZE, bytesPerSecond: 128 * 1024 })
    let refused: number | null = null
    origin.setRule(({ path, range }) => {
      if (path === '/start') return { redirect: `/files/test.bin?sig=${refused === null ? 1 : 2}` }
      if (path !== '/files/test.bin?sig=1' || isProbe(range)) return 'ok'
      // The first request to begin partway into the last block is a split's.
      if (refused === null && range && range.start > LAST) refused = range.start
      return refused === null ? 'ok' : { status: 403 }
    })
    await plexo.start(origin.url('/start'), origin.sha256, { connections: 4 })

    const done = await plexo.waitForHttpStatus(['completed', 'error'], 60_000)
    expect(refused, 'a split was refused').not.toBeNull()
    expect(done.status).toBe('completed')
    expect(done.url).toBe(origin.url('/files/test.bin?sig=2'))
    expect(done.bytesDownloaded).toBe(SPLIT_SIZE)
    expect(startRequests(origin)).toBe(2)

    const served = origin.chunkRequests().filter((r) => r.status === 200 || r.status === 206)
    expect(
      served.some(
        (r) =>
          r.path === '/files/test.bin?sig=2' &&
          r.range !== null &&
          r.range.start <= refused! &&
          (r.range.end === null || r.range.end >= refused!) &&
          r.bytesSent > 0
      ),
      'the refused part came from the fresh URL'
    ).toBe(true)
    // A holder cut short leaves a little of its response unread, and the fresh URL's check
    // samples a few bytes: nothing more is fetched twice.
    expect(served.reduce((sum, r) => sum + r.bytesSent, 0)).toBeLessThan(SPLIT_SIZE + 256 * 1024)
  })
})
