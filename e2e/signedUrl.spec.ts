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
