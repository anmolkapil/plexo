import { cp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes } from './origin'

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

    const restored = await plexo.currentHttp()
    expect(restored?.id).toBe(id)
    expect(restored?.status).toBe('paused')
    expect(restored?.bytesDownloaded).toBeGreaterThan(0)

    await plexo.api.resumeDownload(id)
    await plexo.waitForHttpStatus('completed')
  })
})

test.describe('crash (SIGKILL) and recover @smoke', () => {
  // Offsets chosen to leave different part-file and manifest states behind: so early no progress
  // has been saved yet, and mid-block. Chaos covers the moments in between.
  for (const offset of [100, 3 * BLOCK + 777]) {
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

      const restored = await plexo.currentHttp()
      expect(restored?.id).toBe(id)
      expect(restored?.status).toBe('paused')

      await plexo.api.resumeDownload(id)
      await plexo.waitForHttpStatus('completed')
    })
  }
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
    await plexo.waitForHttpStatus('paused')
    origin.release()
    return { id, origin }
  }

  test('a corrupt manifest does not stop the app from starting', async ({ plexo, serve, dirs }) => {
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()
    await writeFile(join(dirs.userData, 'downloads', id, 'manifest.json'), 'not json {')
    await plexo.launch()
    expect(await plexo.currentHttp()).toBeNull()
    // Nothing can bring it back: its folder is cleared rather than kept forever.
    await expect.poll(() => existsSync(join(dirs.userData, 'downloads', id))).toBe(false)

    // And a new download still works.
    const origin = await serve({ size: 4 * BLOCK, seed: 99 })
    await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForHttpStatus('completed')
  })

  test('two saved downloads of one partial file: only the newest is restored', async ({
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
    expect((await plexo.currentHttp())?.id).toBe(id)
    await expect.poll(() => existsSync(join(root, olderId))).toBe(false)

    await plexo.api.resumeDownload(id)
    await plexo.waitForHttpStatus('completed')
  })

  test('staging file deleted while the app was closed → reports lost progress', async ({
    plexo,
    serve
  }) => {
    await pausedDownload(plexo, serve)
    const partial = `${(await plexo.currentHttp())!.destinationPath}.plexo`
    await plexo.quit()
    await rm(partial)
    await plexo.launch()
    expect((await plexo.currentHttp())?.status).toBe('error')
    expect((await plexo.currentHttp())?.error).toMatch(/partial download file is missing/)
  })

  test('downloads an older version saved are cleared, partial data and all', async ({
    plexo,
    serve,
    dirs
  }) => {
    // A paused download of this version's, which the clearing must leave alone.
    const { id } = await pausedDownload(plexo, serve)
    await plexo.quit()
    const root = join(dirs.userData, 'downloads')
    const manifest = (folder: string, content: object): Promise<void> =>
      mkdir(join(root, folder), { recursive: true }).then(() =>
        writeFile(join(root, folder, 'manifest.json'), JSON.stringify(content))
      )

    // What rc.1–rc.9 left: manifest version 2, the parts in a folder of their own, and the final
    // name claimed as an empty file.
    const oldId = '00000000-0000-4000-8000-000000000002'
    const placeholder = join(dirs.dest, 'old-movie.mkv')
    await manifest(oldId, {
      version: 2,
      state: { id: oldId, destinationPath: placeholder, status: 'paused' }
    })
    await mkdir(join(root, oldId, 'parts'))
    await writeFile(join(root, oldId, 'parts', '0'), seededBytes(1000, 5))
    await writeFile(placeholder, '')

    // A layout this version doesn't read, with its staging file beside the destination.
    const laterId = '00000000-0000-4000-8000-000000000005'
    const staging = join(dirs.dest, 'other.iso.plexo')
    await manifest(laterId, {
      version: 5,
      partialPath: staging,
      state: { id: laterId, destinationPath: join(dirs.dest, 'other.iso'), status: 'paused' }
    })
    await writeFile(staging, seededBytes(1000, 6))

    // An old manifest naming a file that holds something: never Plexo's to delete.
    const realId = '00000000-0000-4000-8000-000000000003'
    const realFile = join(dirs.dest, 'mine.txt')
    await manifest(realId, {
      version: 2,
      state: { id: realId, destinationPath: realFile, status: 'paused' }
    })
    await writeFile(realFile, 'keep me')

    await plexo.launch()
    expect((await plexo.currentHttp())?.id).toBe(id)
    for (const gone of [join(root, oldId), placeholder, join(root, laterId), staging]) {
      await expect.poll(() => existsSync(gone), { message: `${gone} cleared` }).toBe(false)
    }
    await expect.poll(() => existsSync(join(root, realId))).toBe(false)
    expect(await readFile(realFile, 'utf-8')).toBe('keep me')
    // Ours, not the download's: out of the way of the end-of-test check for stray files.
    await rm(realFile)

    await plexo.api.resumeDownload(id)
    await plexo.waitForHttpStatus('completed')
  })

  test('a staging file cut short while the app was closed is fetched again', async ({
    plexo,
    serve
  }) => {
    // What a power cut can do: the manifest says a block is done, but its data never all
    // reached the disk.
    const { id } = await pausedDownload(plexo, serve)
    const state = (await plexo.currentHttp())!
    const done = state.blocks!.find((block) => block.status === 'completed')!
    await plexo.quit()
    const staging = `${state.destinationPath}.plexo`
    await truncate(staging, done.rangeStart + 1000)

    await plexo.launch()
    await plexo.api.resumeDownload(id)
    await plexo.waitForHttpStatus('completed')
  })
})
