import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { QueueItem, QueueState } from '../src/shared/types'
import { expect, interfacesEnv, LAN_ADDRESS, NETWORKS, test, type PlexoApp } from './fixtures'
import { sha256, type Origin } from './origin'

// Q. The download queue: links downloaded one after another, through the same download
// machinery as a single download.

async function queueOf(plexo: PlexoApp): Promise<QueueState> {
  return plexo.api.getQueue()
}

/** Waits until the queue matches `predicate`; a timeout says what it looked like instead. */
async function waitForQueue(
  plexo: PlexoApp,
  predicate: (queue: QueueState) => boolean,
  timeout = 30_000
): Promise<QueueState> {
  const deadline = Date.now() + timeout
  let queue: QueueState | null = null
  while (Date.now() < deadline) {
    queue = await queueOf(plexo)
    if (predicate(queue)) return queue
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const items = queue?.items.map(
    (item) => `${item.fileName ?? item.url}:${item.status}${item.error ? ` (${item.error})` : ''}`
  )
  throw new Error(`Timed out waiting on the queue. Last seen: [${items?.join(', ')}]`)
}

const allDone = (queue: QueueState): boolean =>
  queue.items.length > 0 &&
  queue.items.every((item) => item.status === 'completed' || item.status === 'failed')

async function expectSavedAs(item: QueueItem, origin: Origin): Promise<void> {
  expect(item.status, `${item.fileName}: ${item.error ?? ''}`).toBe('completed')
  expect(sha256(await readFile(item.destinationPath!)), `${item.fileName} matches`).toBe(
    origin.sha256
  )
}

// Every file the queue saves lands in the test's own folder, not the user's Downloads.
test.beforeEach(async ({ plexo }) => {
  await plexo.api.queueCommand({ kind: 'setDestination', dir: plexo.dirs.dest })
})

// However a test ends, no download's staging file is left behind in the destination.
test.afterEach(async ({ plexo }) => {
  const staging = async (): Promise<string[]> =>
    (await readdir(plexo.dirs.dest)).filter((name) => name.endsWith('.plexo'))
  await expect.poll(staging, { message: 'no staging files left behind' }).toEqual([])
})

test.describe('download queue @smoke', () => {
  test('pasted links download one after another, into one folder', async ({ plexo, serve }) => {
    const origins = await Promise.all(
      [1, 2, 3].map((seed) => serve({ size: 600 * 1024, seed, bytesPerSecond: 3_000_000 }))
    )
    const urls = origins.map((origin, index) => origin.url(`/files/part${index + 1}.bin`))

    const added = await plexo.api.addToQueue(
      urls.map((url) => ({ url })),
      { start: true }
    )
    expect(added).toEqual({ added: 3, duplicates: 0 })
    // The same links again are already there.
    expect(await plexo.api.addToQueue([{ url: urls[0] }], { start: true })).toMatchObject({
      added: 0,
      duplicates: 1
    })

    const queue = await waitForQueue(plexo, allDone)
    expect(queue.items.map((item) => item.fileName)).toEqual([
      'part1.bin',
      'part2.bin',
      'part3.bin'
    ])
    for (const [index, item] of queue.items.entries()) await expectSavedAs(item, origins[index])

    // One at a time: each file's transfer only began once the one before it had finished.
    for (let index = 1; index < origins.length; index++) {
      const previousLast = Math.max(...origins[index - 1].chunkRequests().map((r) => r.at))
      const nextFirst = Math.min(...origins[index].chunkRequests().map((r) => r.at))
      expect(nextFirst, `part${index + 1} waited for part${index}`).toBeGreaterThanOrEqual(
        previousLast
      )
    }
  })

  test('a link that stopped working fails clearly, and the queue moves on', async ({
    plexo,
    serve
  }) => {
    const gone = await serve({ size: 64 * 1024 })
    gone.setRule(() => ({ status: 403 }))
    const page = await serve({ size: 64 * 1024 })
    page.setRule(() => ({ status: 200, headers: { 'Content-Type': 'text/html' } }))
    const good = await serve({ size: 300 * 1024, seed: 7 })

    await plexo.api.addToQueue(
      [
        { url: gone.url('/files/gone.bin') },
        { url: page.url('/files/page.bin') },
        { url: good.url('/files/good.bin') }
      ],
      { start: true }
    )
    const queue = await waitForQueue(plexo, allDone)
    const [first, second, third] = queue.items
    expect(first).toMatchObject({ status: 'failed', problem: 'expired' })
    expect(second).toMatchObject({ status: 'failed', problem: 'expired' })
    expect(second.error).toContain('web page')
    await expectSavedAs(third, good)

    // The link works again and is added again: the failed item goes again, not a second one.
    gone.setRule(() => undefined)
    await plexo.api.addToQueue([{ url: gone.url('/files/gone.bin') }], { start: true })
    const again = await waitForQueue(plexo, (state) => state.items[0]?.status === 'completed')
    expect(again.items).toHaveLength(3)
    await expectSavedAs(again.items[0], gone)
  })

  test('a relaunch brings the queue back stopped, and it carries on from there', async ({
    plexo,
    serve
  }) => {
    const slow = await serve({ size: 1024 * 1024, seed: 3, bytesPerSecond: 100_000 })
    const next = await serve({ size: 200 * 1024, seed: 4 })
    await plexo.api.addToQueue(
      [{ url: slow.url('/files/slow.bin') }, { url: next.url('/files/next.bin') }],
      { start: true }
    )
    await waitForQueue(plexo, (queue) =>
      queue.items.some((item) => item.status === 'active' && (item.bytesDownloaded ?? 0) > 0)
    )

    await plexo.relaunch()
    const restored = await waitForQueue(plexo, (queue) => queue.items.length === 2)
    expect(restored.running).toBe(false)
    expect(restored.items.map((item) => item.status)).toEqual(['active', 'queued'])
    expect((await plexo.current())?.status).toBe('paused')

    await plexo.api.queueCommand({ kind: 'start' })
    const queue = await waitForQueue(plexo, allDone)
    await expectSavedAs(queue.items[0], slow)
    await expectSavedAs(queue.items[1], next)
  })
})

test.describe('queue safety', () => {
  test('a saved queue that can’t be read is reported, and never saved over', async ({
    plexo,
    serve,
    dirs
  }) => {
    await plexo.quit()
    // Something that isn't a readable file where queue.json goes, as a lock would make it.
    const path = join(dirs.userData, 'queue.json')
    await rm(path, { force: true })
    await mkdir(path)
    await plexo.launch()
    await plexo.api.queueCommand({ kind: 'setDestination', dir: dirs.dest })

    const queue = await waitForQueue(plexo, (state) => !!state.loadError, 10_000)
    expect(queue.loadError).toMatch(/couldn’t read its saved queue/)
    // The queue still works for this session…
    const origin = await serve({ size: 100 * 1024, seed: 51 })
    await plexo.api.addToQueue([{ url: origin.url('/files/session.bin') }], { start: true })
    const [item] = (await waitForQueue(plexo, allDone)).items
    await expectSavedAs(item, origin)
    // In the folder picked while the queue was still loading, not the default one.
    expect(dirname(item.destinationPath!)).toBe(dirs.dest)
    // …but what's there is left as it was.
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  test('a change made just before quitting is saved', async ({ plexo, serve }) => {
    const origin = await serve({ size: 64 * 1024, seed: 52 })
    await plexo.api.addToQueue([{ url: origin.url('/files/late.bin') }], { start: false })
    await plexo.quit()
    await plexo.launch()
    const queue = await waitForQueue(plexo, (state) => state.items.length > 0, 10_000)
    expect(queue.items.map((item) => item.url)).toEqual([origin.url('/files/late.bin')])
  })

  test('a download started just before quitting is found again, not started twice', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 1024 * 1024, seed: 53, bytesPerSecond: 100_000 })
    await plexo.api.addToQueue([{ url: origin.url('/files/once.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.quit()

    // As if the app had quit before the queue could note which download was its item's.
    const path = join(dirs.userData, 'queue.json')
    const saved = JSON.parse(await readFile(path, 'utf-8'))
    saved.items[0].status = 'queued'
    delete saved.items[0].downloadId
    await writeFile(path, JSON.stringify(saved))

    await plexo.launch()
    const restored = await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'active')
    expect(restored.items[0].downloadId).toBe((await plexo.current())?.id)
    await plexo.api.queueCommand({ kind: 'start' })
    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], origin)
    expect(await readdir(dirs.dest)).toEqual(['once.bin'])
  })

  test('removing an old download never touches the staging file of a new one by the same name', async ({
    plexo,
    serve,
    dirs
  }) => {
    const first = await serve({ size: 64 * 1024, seed: 54 })
    const oldId = await plexo.start(first.url('/files/same.bin'), first.sha256)
    await plexo.waitForStatus('completed')
    // The finished file is deleted, so the name is free for the next download of it.
    await rm(join(dirs.dest, 'same.bin'))

    const second = await serve({ size: 1024 * 1024, seed: 55, bytesPerSecond: 150_000 })
    await plexo.api.addToQueue([{ url: second.url('/other/same.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.api.removeDownload(oldId)

    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], second)
  })

  test('a failure is classified by what the server answered, not by its wording', async ({
    plexo,
    serve
  }) => {
    // Both answer the probe, then send a 200 where the file's bytes should be: one a web page
    // (a link that stopped working), one not (a server that stopped serving parts).
    const page = await serve({ size: 256 * 1024, seed: 56 })
    page.setRule((request) =>
      request.range && request.range.end !== 0
        ? { status: 200, headers: { 'Content-Type': 'text/html' } }
        : undefined
    )
    const whole = await serve({ size: 256 * 1024, seed: 57 })
    whole.setRule((request) =>
      request.range && request.range.end !== 0 ? { status: 200 } : undefined
    )
    await plexo.api.addToQueue(
      [{ url: page.url('/files/page.bin') }, { url: whole.url('/files/whole.bin') }],
      { start: true }
    )
    const queue = await waitForQueue(plexo, allDone, 60_000)
    const byName = (name: string): QueueItem | undefined =>
      queue.items.find((item) => item.url.endsWith(name))
    expect(byName('page.bin')).toMatchObject({ status: 'failed', problem: 'expired' })
    // Not the link's fault: it got its automatic second try before failing.
    expect(byName('whole.bin')).toMatchObject({ status: 'failed', problem: 'other', attempts: 2 })
  })

  test('the queue starts downloads only on the networks left on at the start screen', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'Needs a second network')
    await plexo.api.updateSettings({ excludedNetworks: ['b'] })
    const origin = await serve({ size: 512 * 1024, seed: 58 })
    await plexo.api.addToQueue([{ url: origin.url('/files/one-network.bin') }], { start: true })
    await expectSavedAs((await waitForQueue(plexo, allDone)).items[0], origin)
    const froms = new Set(origin.chunkRequests().map((request) => request.from))
    expect([...froms]).toEqual(['127.0.0.1'])
  })

  test('a retry whose link now leads elsewhere resumes only if it serves the same bytes', async ({
    plexo,
    serve
  }) => {
    // Same size, no ETag or Last-Modified: nothing in the headers tells the files apart.
    const size = 1536 * 1024
    const first = await serve({ size, seed: 63, etag: null, bytesPerSecond: 150_000 })
    const other = await serve({ size, seed: 64, etag: null })
    // Each link redirects to where the file is now; the first place stops serving it midway.
    const expired = new Set<string>()
    let target = (name: string): string => `/old/${name}`
    first.setRule(({ path }) => {
      if (path.startsWith('/start/')) return { redirect: target(path.slice('/start/'.length)) }
      return expired.has(path) ? { status: 403 } : undefined
    })
    await plexo.api.addToQueue(
      [{ url: first.url('/start/same.bin') }, { url: first.url('/start/swapped.bin') }],
      { start: true }
    )
    for (const [index, name] of ['same.bin', 'swapped.bin'].entries()) {
      await waitForQueue(plexo, (queue) => (queue.items[index]?.bytesDownloaded ?? 0) > size / 4)
      expired.add(`/old/${name}`)
      await waitForQueue(plexo, (queue) => queue.items[index]?.status === 'failed')
    }
    const failed = await queueOf(plexo)
    for (const item of failed.items) expect(item).toMatchObject({ problem: 'expired' })
    const kept = failed.items[0].bytesDownloaded ?? 0
    expect(kept).toBeGreaterThan(0)

    // Now the same file is served from a new place — and the other link leads to another file.
    target = (name) => (name === 'same.bin' ? `/new/${name}` : other.url(`/new/${name}`))
    await plexo.api.queueCommand({ kind: 'retryFailed' })
    const queue = await waitForQueue(
      plexo,
      (state) => allDone(state) && state.items.every((item) => item.status === 'completed')
    )
    await expectSavedAs(queue.items[0], first)
    // Resumed: the new place only served what was missing.
    const fetchedAgain = first
      .chunkRequests()
      .filter((request) => request.path.startsWith('/new/'))
      .reduce((sum, request) => sum + request.bytesSent, 0)
    expect(fetchedAgain).toBeLessThanOrEqual(size - kept + 256 * 1024)
    // Compared with what was on disk, found different, and started over.
    await expectSavedAs(queue.items[1], other)
  })
})

test.describe('the queue and the main screen', () => {
  test('Download Again on a cancelled queue download sends it back to the queue', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 1024 * 1024, seed: 71, bytesPerSecond: 150_000 })
    await plexo.api.addToQueue([{ url: origin.url('/files/again.bin') }], { start: true })
    const started = await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.api.cancelDownload(started.items[0].downloadId!)
    await waitForQueue(plexo, (queue) => queue.items[0]?.problem === 'cancelled')

    await plexo.page.getByRole('button', { name: 'Download Again' }).click()
    const queue = await waitForQueue(plexo, (state) => state.items[0]?.status === 'completed')
    // The same item, downloaded into the queue's folder — not a download of its own.
    expect(queue.items).toHaveLength(1)
    await expectSavedAs(queue.items[0], origin)
    expect(dirname(queue.items[0].destinationPath!)).toBe(dirs.dest)
  })

  test('Resume on the main screen after a relaunch carries the queue on', async ({
    plexo,
    serve
  }) => {
    const slow = await serve({ size: 1024 * 1024, seed: 72, bytesPerSecond: 150_000 })
    const next = await serve({ size: 200 * 1024, seed: 73 })
    await plexo.api.addToQueue(
      [{ url: slow.url('/files/first.bin') }, { url: next.url('/files/second.bin') }],
      { start: true }
    )
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.relaunch()
    await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'active')

    await plexo.page.getByRole('button', { name: 'Resume', exact: true }).click()
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    await expectSavedAs(queue.items[0], slow)
    await expectSavedAs(queue.items[1], next)
  })

  test('a download started on its own is named in the queue, which waits for it', async ({
    plexo,
    serve
  }) => {
    const queued = await serve({ size: 64 * 1024, seed: 74 })
    const own = await serve({ size: 1024 * 1024, seed: 75, bytesPerSecond: 40_000 })
    await plexo.api.addToQueue([{ url: queued.url('/files/waiting.bin') }], { start: false })

    await plexo.start(own.url('/files/own.bin'), own.sha256)
    await plexo.page.getByRole('button', { name: /^Queue/ }).click()
    await expect(plexo.page.getByRole('status').filter({ hasText: 'outside' })).toHaveText(
      'own.bin is downloading on its own, outside the queue. The queue carries on once it’s done.'
    )
    await plexo.waitForStatus('completed')
  })
})

test.describe('failures and retries', () => {
  /** What the computer's networks are now, as the app will see them at its next look. */
  const setNetworks = (plexo: PlexoApp, value: string): Promise<void> =>
    plexo.evaluateMain((_electron, networks) => {
      process.env['PLEXO_E2E_INTERFACES'] = networks
    }, value)

  test('with no network, the queue waits instead of failing every item, then carries on', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 128 * 1024, seed: 81 })
    await setNetworks(plexo, '')
    await plexo.api.addToQueue(
      [{ url: origin.url('/files/first.bin') }, { url: origin.url('/files/second.bin') }],
      { start: true }
    )
    const waiting = await waitForQueue(plexo, (queue) => queue.waitingForNetwork)
    expect(waiting.items.map((item) => [item.status, item.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0]
    ])

    await setNetworks(plexo, interfacesEnv(NETWORKS))
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    expect(queue.waitingForNetwork).toBe(false)
    for (const item of queue.items) await expectSavedAs(item, origin)
  })

  test('a folder that can’t be saved to stops the queue with the reason, failing nothing', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 64 * 1024, seed: 82 })
    const notAFolder = join(dirs.dest, 'not-a-folder')
    await writeFile(notAFolder, 'x')
    await plexo.api.queueCommand({ kind: 'setDestination', dir: join(notAFolder, 'inside') })
    await plexo.api.addToQueue(
      [{ url: origin.url('/files/first.bin') }, { url: origin.url('/files/second.bin') }],
      { start: true }
    )
    const stopped = await waitForQueue(plexo, (queue) => !!queue.stoppedBecause)
    expect(stopped.running).toBe(false)
    expect(stopped.stoppedBecause).toMatch(/^Can’t save to .*inside: /)
    expect(stopped.items.map((item) => [item.status, item.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0]
    ])

    // Another folder, and the queue goes on from where it stopped.
    await rm(notAFolder)
    await plexo.api.queueCommand({ kind: 'setDestination', dir: dirs.dest })
    await plexo.api.queueCommand({ kind: 'start' })
    const queue = await waitForQueue(plexo, (state) =>
      state.items.every((item) => item.status === 'completed')
    )
    expect(queue.stoppedBecause).toBeUndefined()
  })

  test('a failure a moment could fix is retried shortly, in its place; one that can’t, isn’t', async ({
    plexo,
    serve
  }) => {
    const flaky = await serve({ size: 64 * 1024, seed: 83 })
    // Busy for its first two looks (the background lookup and the first start), fine after.
    let busy = 2
    flaky.setRule((request) =>
      request.range?.end === 0 && busy-- > 0 ? { status: 503 } : undefined
    )
    const refused = await serve({ size: 64 * 1024, seed: 84 })
    refused.setRule(() => ({ status: 400 }))
    const next = await serve({ size: 64 * 1024, seed: 85 })
    await plexo.api.addToQueue(
      [
        { url: flaky.url('/files/flaky.bin') },
        { url: refused.url('/files/refused.bin') },
        { url: next.url('/files/next.bin') }
      ],
      { start: true }
    )
    const queue = await waitForQueue(plexo, (state) => allDone(state) && !state.items[0].retryAt)
    // Still first in the list, done on its second try, after the others had their turn.
    expect(queue.items.map((item) => [item.status, item.attempts])).toEqual([
      ['completed', 2],
      ['failed', 1],
      ['completed', 1]
    ])
    await expectSavedAs(queue.items[0], flaky)
    const nextStarted = Math.min(...next.chunkRequests().map((request) => request.at))
    const flakyStarted = Math.min(...flaky.chunkRequests().map((request) => request.at))
    expect(nextStarted).toBeLessThan(flakyStarted)
  })

  test('pausing the queue while the next link is being checked doesn’t start it', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 256 * 1024, seed: 86 })
    // A link that answers only when the test lets it: long enough to pause in between.
    let letGo: () => void = () => {}
    const answered = new Promise<void>((resolve) => (letGo = resolve))
    const slow = createServer((req, res) => {
      void answered.then(() => {
        res.writeHead(302, { Location: origin.url(req.url ?? '/') }).end()
      })
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = slow.address() as AddressInfo
      await plexo.api.addToQueue([{ url: `http://127.0.0.1:${port}/files/held.bin` }], {
        start: true
      })
      await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'starting')
      // Stopping waits for the check under way, so the link answers once the queue is stopped.
      const stopping = plexo.api.queueCommand({ kind: 'stop' })
      await waitForQueue(plexo, (queue) => !queue.running)
      letGo()
      await stopping

      const queue = await waitForQueue(plexo, (state) => state.items[0]?.status === 'queued')
      expect(queue.running).toBe(false)
      expect(queue.items[0].attempts).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(await plexo.current()).toBeNull()
      expect(origin.chunkRequests()).toEqual([])
    } finally {
      letGo()
      slow.closeAllConnections()
      slow.close()
    }
  })

  test('New Download on a failed queue download’s screen keeps what it fetched, for Retry', async ({
    plexo,
    serve
  }) => {
    const size = 1024 * 1024
    const origin = await serve({ size, seed: 87, bytesPerSecond: 150_000 })
    let refusing = false
    origin.setRule((request) =>
      refusing && request.range && request.range.end !== 0 ? { status: 403 } : undefined
    )
    await plexo.api.addToQueue([{ url: origin.url('/files/kept.bin') }], { start: true })
    await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > size / 4)
    refusing = true
    const failed = await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'failed')
    const kept = failed.items[0].bytesDownloaded ?? 0

    await plexo.page.getByRole('button', { name: 'New Download' }).click()
    await expect(plexo.page.getByRole('button', { name: 'Start' })).toBeVisible()

    refusing = false
    const retriedAt = Date.now()
    await plexo.api.queueCommand({ kind: 'retry', id: failed.items[0].id })
    const [item] = (await waitForQueue(plexo, (queue) => queue.items[0]?.status === 'completed'))
      .items
    await expectSavedAs(item, origin)
    const fetchedAgain = origin
      .chunkRequests()
      .filter((request) => request.at >= retriedAt)
      .reduce((sum, request) => sum + request.bytesSent, 0)
    expect(fetchedAgain).toBeLessThanOrEqual(size - kept + 256 * 1024)
  })
})

test.describe('cancelling and removing', () => {
  test('a cancelled download isn’t a failure: not retried with the failed ones, and cleared with the finished', async ({
    plexo,
    serve
  }) => {
    const slow = await serve({ size: 1024 * 1024, seed: 91, bytesPerSecond: 150_000 })
    const next = await serve({ size: 64 * 1024, seed: 92 })
    await plexo.api.addToQueue(
      [{ url: slow.url('/files/cancelled.bin') }, { url: next.url('/files/next.bin') }],
      { start: true }
    )
    const started = await waitForQueue(plexo, (queue) => (queue.items[0]?.bytesDownloaded ?? 0) > 0)
    await plexo.api.cancelDownload(started.items[0].downloadId!)
    await waitForQueue(plexo, (queue) => queue.items[1]?.status === 'completed')
    await expect(plexo.page.getByRole('button', { name: /^Queue/ })).toHaveAccessibleName(
      'Queue: 1 of 2 done'
    )

    await plexo.api.queueCommand({ kind: 'retryFailed' })
    expect((await queueOf(plexo)).items[0]).toMatchObject({
      status: 'failed',
      problem: 'cancelled'
    })
    await plexo.api.queueCommand({ kind: 'clearFinished' })
    await waitForQueue(plexo, (queue) => queue.items.length === 0)
  })

  test('removing a queue item while its failed download is on screen leaves that screen', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 256 * 1024, seed: 93 })
    // The link checks out, then every request for the file is refused.
    origin.setRule((request) => (request.range?.end !== 0 ? { status: 403 } : undefined))
    await plexo.api.addToQueue([{ url: origin.url('/files/refused.bin') }], { start: true })
    const [item] = (await waitForQueue(plexo, allDone)).items
    await expect(plexo.page.getByText('Download Failed')).toBeVisible()

    await plexo.api.queueCommand({ kind: 'remove', id: item.id })
    await expect(plexo.page.getByRole('button', { name: 'Start' })).toBeVisible()
  })
})
