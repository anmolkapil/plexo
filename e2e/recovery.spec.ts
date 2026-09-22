import { cp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes, sha256 } from './origin'

// D. Quitting, crashing and restarting. kill() is SIGKILL: no before-quit, no final save —
// what's on disk is whatever the app had managed to persist, exactly as after a crash or a
// power cut.

const SIZE = 32 * BLOCK

test.describe('restart @smoke', () => {
  test('normal quit mid-download → relaunch paused → resume', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    const reached = origin.hold(10 * BLOCK + 500)
    const id = await plexo.start(origin.url(), origin.sha256, { connections: 2 })
    await reached

    await plexo.quit()
    origin.release()
    await plexo.launch()

    const restored = await plexo.current()
    expect(restored?.id).toBe(id)
    expect(restored?.status).toBe('paused')
    expect(restored?.bytesDownloaded).toBeGreaterThan(0)

    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('a completed download is still there after a restart', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    await plexo.start(origin.url(), origin.sha256)
    const done = await plexo.waitForStatus('completed')

    await plexo.relaunch()
    const restored = await plexo.current()
    expect(restored?.status).toBe('completed')
    expect(sha256(await readFile(done.destinationPath))).toBe(origin.sha256)
  })
})

test.describe('crash (SIGKILL) and recover @smoke', () => {
  // Offsets chosen to land in different places: so early no progress has been saved yet,
  // mid-block, a block boundary, and the tail — each leaves different part-file and manifest
  // states behind. Chaos covers the moments in between.
  for (const offset of [100, 3 * BLOCK + 777, 12 * BLOCK, SIZE - 10]) {
    test(`killed with a response held at byte ${offset}`, async ({ plexo, serve }) => {
      const origin = await serve({ size: SIZE, seed: offset })
      const reached = origin.hold(offset)
      const id = await plexo.start(origin.url(), origin.sha256, { connections: 4 })
      await reached
      // Give progress events and the throttled manifest save a chance to (partly) happen.
      await plexo.waitUntil((state) => state.bytesDownloaded > 0)

      await plexo.kill()
      origin.release()
      await plexo.launch()

      const restored = await plexo.current()
      expect(restored?.id).toBe(id)
      expect(restored?.status).toBe('paused')

      await plexo.api.resumeDownload(id)
      await plexo.waitForStatus('completed')
    })
  }

  test('killed while assembling → relaunch paused → resume re-assembles', async ({
    plexo,
    dirs
  }) => {
    // A simulated download can throttle the assemble step, which keeps it in 'assembling'
    // long enough to kill it there.
    const source = join(dirs.userData, '..', 'source.bin')
    const bytes = seededBytes(SIZE, 21)
    await writeFile(source, bytes)
    const id = await plexo.startSimulated(
      {
        sourceFilePath: source,
        networks: [{ kind: 'ethernet', label: 'sim', speedBytesPerSec: 50e6, faultRatePercent: 0 }],
        chunkCount: 2,
        connectionsPerNetwork: 2,
        assembleSpeedBytesPerSec: SIZE / 4
      },
      sha256(bytes)
    )
    await plexo.waitUntil(
      (state) => state.status === 'assembling' && (state.assembledBytes ?? 0) > 0
    )

    await plexo.kill()
    await plexo.launch()
    expect((await plexo.current())?.status).toBe('paused')

    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })
})

test.describe('persisted state on disk @smoke', () => {
  async function pausedDownload(
    plexo: import('./fixtures').PlexoApp,
    serve: (o: { size: number; seed?: number }) => Promise<import('./origin').Origin>,
    seed = 1
  ): Promise<{ id: string; origin: import('./origin').Origin }> {
    const origin = await serve({ size: SIZE, seed })
    const reached = origin.hold(8 * BLOCK)
    const id = await plexo.start(origin.url(), origin.sha256)
    await reached
    await plexo.api.pauseDownload(id)
    await plexo.waitForStatus('paused')
    origin.release()
    return { id, origin }
  }

  test('a leftover manifest.json.tmp is ignored', async ({ plexo, serve, dirs }) => {
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()
    await writeFile(join(dirs.userData, 'downloads', id, 'manifest.json.tmp'), '{"half":')
    await plexo.launch()
    expect((await plexo.current())?.id).toBe(id)
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('a corrupt manifest does not stop the app from starting', async ({ plexo, serve, dirs }) => {
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()
    await writeFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'not json {')
    await plexo.launch()
    expect(await plexo.current()).toBeNull()

    // And a new download still works.
    const origin = await serve({ size: 4 * BLOCK, seed: 99 })
    await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForStatus('completed')
  })

  test('two saved downloads: only the newest is restored, the other is removed', async ({
    plexo,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()

    // Clone the saved download under another id, dated an hour earlier.
    const root = join(dirs.userData, 'downloads')
    const olderId = '00000000-0000-4000-8000-000000000000'
    await cp(join(root, id), join(root, olderId), { recursive: true })
    const manifestPath = join(root, olderId, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'))
    manifest.state.id = olderId
    manifest.state.startedAt -= 3_600_000
    await writeFile(manifestPath, JSON.stringify(manifest))

    await plexo.launch()
    expect((await plexo.current())?.id).toBe(id)
    await expect.poll(() => existsSync(join(root, olderId))).toBe(false)

    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })

  test('part files deleted while the app was closed → re-downloads them', async ({
    plexo,
    serve,
    dirs
  }) => {
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()
    await rm(join(dirs.userData, 'downloads', id, 'parts'), { recursive: true, force: true })
    await plexo.launch()
    await plexo.api.resumeDownload(id)
    const state = await plexo.waitForStatus(['completed', 'error'])
    expect(state.error).toBeUndefined()
  })

  test('a finished part file cut short while the app was closed is fetched again', async ({
    plexo,
    serve,
    dirs
  }) => {
    // What a power cut can do: the manifest says a block is done, but its data never all
    // reached the disk.
    const { id } = await pausedDownload(plexo, serve)
    const done = (await plexo.current())!.blocks!.find((block) => block.status === 'completed')!
    await plexo.quit()
    const part = join(dirs.userData, 'downloads', id, 'parts', `part-${done.index}`)
    await truncate(part, 1000)

    await plexo.launch()
    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed')
  })
})
