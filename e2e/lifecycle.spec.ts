import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, interfacesEnv, LAN_ADDRESS, NETWORKS, test } from './fixtures'
import { seededBytes, sha256 } from './origin'

// C. Pause, resume, cancel, remove. Pause points are set with origin.hold(offset), so each one
// lands at the same byte every run instead of wherever a timer happened to fire.

const SIZE = 24 * BLOCK

test.describe('pause and resume @smoke', () => {
  const points: [string, number][] = [
    ['right at the start', 1],
    ['partway through a block', 5 * BLOCK + 1234],
    ['exactly on a block boundary', 8 * BLOCK],
    ['in the last block', SIZE - 100]
  ]
  for (const [label, offset] of points) {
    test(`pause ${label}, then resume`, async ({ plexo, serve }) => {
      const origin = await serve({ size: SIZE })
      const reached = origin.hold(offset)
      const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
      await reached

      await plexo.api.pauseDownload(id)
      const paused = await plexo.waitForStatus('paused')
      expect(paused.speedBytesPerSec).toBe(0)
      origin.release()

      await plexo.api.resumeDownload(id)
      await plexo.waitForStatus('completed')
    })
  }

  test('rapid pause/resume, 20 times', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(6 * BLOCK + 10)
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await reached
    for (let i = 0; i < 20; i++) {
      await plexo.api.pauseDownload(id)
      await plexo.api.resumeDownload(id)
    }
    origin.release()
    await plexo.waitForStatus('completed')
  })

  test('pause and resume several times over the whole file', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE, seed: 5 })
    let reached = origin.hold(2 * BLOCK + 5)
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    for (let round = 0; round < 3; round++) {
      await reached
      await plexo.api.pauseDownload(id)
      const paused = await plexo.waitForStatus('paused')
      origin.release()
      // Hold next at a byte the app hasn't fetched yet — a fixed offset could already be done
      // by another connection, and a hold that's never reached would hang the test.
      const next = paused.blocks?.find((block) => block.status !== 'completed')
      if (!next) break
      reached = origin.hold(next.rangeStart + next.bytesDownloaded)
      await plexo.api.resumeDownload(id)
    }
    origin.release()
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })
})

test.describe('pause during a retry backoff', () => {
  test.use({ appEnv: { PLEXO_E2E_RETRY_BASE_MS: '5000' } })

  test('pausing does not wait out the backoff @smoke', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    let failing = true
    origin.setRule(({ range }) =>
      failing && range && range.start === 4 * BLOCK ? { status: 500 } : 'ok'
    )
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await plexo.waitUntil((state) => state.chunks.some((chunk) => chunk.status === 'retrying'))

    const before = Date.now()
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused', 2000)
    expect(Date.now() - before).toBeLessThan(2000)

    failing = false
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })
})

test.describe('resume safety checks @smoke', () => {
  /** Starts a download, pauses it partway, and lets `change` alter the server while paused. */
  async function pauseThenChange(
    plexo: import('./fixtures').PlexoApp,
    origin: import('./origin').Origin,
    change: () => void
  ): Promise<{
    id: string
    resumedAt: number
    paused: import('../src/shared/types').DownloadState
  }> {
    const reached = origin.hold(5 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    await plexo.api.pauseDownload(id)
    const paused = await plexo.waitForStatus('paused')
    change()
    origin.release()
    const resumedAt = origin.log.length
    await plexo.api.resumeDownload(id)
    return { id, resumedAt, paused }
  }

  test('a new version published while paused (new ETag) → error, nothing kept', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    await pauseThenChange(plexo, origin, () => origin.setContent(seededBytes(SIZE, 9), '"v2"'))
    const state = await plexo.waitForStatus('error')
    expect(state.error).toMatch(/changed/)
  })

  test('a new version published while paused (new Last-Modified) → error', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({
      size: SIZE,
      etag: null,
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT'
    })
    await pauseThenChange(plexo, origin, () => {
      origin.setContent(seededBytes(SIZE, 9), null)
      origin.lastModified = 'Thu, 02 Jan 2025 00:00:00 GMT'
    })
    await plexo.waitForStatus('error')
  })

  test('same bytes under a new ETag while paused (server migrated) → resumes, progress kept', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    const { resumedAt, paused } = await pauseThenChange(plexo, origin, () =>
      origin.setContent(origin.content, '"migrated"')
    )
    await plexo.waitForStatus('completed')

    // Kept, not restarted: after resuming, no block that was already complete was fetched again
    // — only the small samples that confirmed the bytes match.
    const done = (paused.blocks ?? []).filter((block) => block.status === 'completed')
    const afterResume = origin.log.slice(resumedAt)
    const refetchedDone = afterResume.filter((entry) =>
      done.some((block) => entry.range?.start === block.rangeStart && entry.bytesSent > 16 * 1024)
    )
    expect(done.length).toBeGreaterThan(0)
    expect(refetchedDone).toEqual([])
    expect(afterResume.some((entry) => entry.bytesSent > 0 && entry.bytesSent <= 16 * 1024)).toBe(
      true
    )
  })

  test('no validators at all → resumes', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE, etag: null, lastModified: null })
    const reached = origin.hold(5 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused')
    origin.release()
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('network gone while paused → stays paused with a message, resumes once it is back', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(5 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256, { networks: ['a'] })
    await reached
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused')
    origin.release()

    const setInterfaces = (value: string): Promise<void> =>
      plexo.evaluateMain((_electron, v) => {
        process.env['PLEXO_E2E_INTERFACES'] = v
      }, value)

    await setInterfaces(interfacesEnv({ b: NETWORKS['b'] }))
    await plexo.api.resumeDownload(id)
    const stuck = await plexo.waitUntil((state) => Boolean(state.error))
    expect(stuck.status).toBe('paused')
    expect(stuck.error).toMatch(/not currently available|None of the networks/)

    await setInterfaces(interfacesEnv(NETWORKS))
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('resume against a server without range support', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE, ranges: false })
    const reached = origin.hold(5 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused')
    origin.release()
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed', 10_000)
  })
})

test.describe('cancel and remove @smoke', () => {
  test('cancel while downloading', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(7 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await reached
    await plexo.api.cancelDownload(id)
    origin.release()
    await plexo.waitForStatus('cancelled')
  })

  test('cancel while paused', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(7 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused')
    origin.release()
    await plexo.api.cancelDownload(id)
    await plexo.waitForStatus('cancelled')
  })

  test('remove after completion keeps the file', async ({ plexo, serve, dirs }) => {
    const origin = await serve({ size: SIZE })
    const id = await plexo.start(origin.url(), origin.sha256)
    const state = await plexo.waitForStatus('completed')
    await plexo.api.removeDownload(id)

    expect(await plexo.current()).toBeNull()
    expect(sha256(await readFile(state.destinationPath))).toBe(origin.sha256)
    await expect.poll(() => existsSync(join(dirs.userData, 'downloads', id))).toBe(false)
  })

  test('remove while downloading deletes everything', async ({ plexo, serve, dirs }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(7 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    const { destinationPath } = (await plexo.current())!
    await plexo.api.removeDownload(id)
    origin.release()

    expect(await plexo.current()).toBeNull()
    await expect.poll(() => existsSync(destinationPath)).toBe(false)
    await expect.poll(() => existsSync(join(dirs.userData, 'downloads', id))).toBe(false)
  })
})
