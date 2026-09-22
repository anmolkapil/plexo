import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOCK, expect, PlexoApp, test } from './fixtures'

// E. The disk: out of space, folders vanishing, no permission. The small volumes are real
// filesystems (a RAM disk on macOS, tmpfs on Linux), so ENOSPC comes from the OS, not a mock.

interface Volume {
  path: string
  dispose: () => Promise<void>
}

/** A real filesystem of `megabytes` size, or null where one can't be made without a password. */
async function smallVolume(megabytes: number): Promise<Volume | null> {
  try {
    if (process.platform === 'darwin') {
      const name = `plexoe2e${process.pid}${Date.now() % 100000}`
      const device = execFileSync('hdiutil', ['attach', '-nomount', `ram://${megabytes * 2048}`])
        .toString()
        .trim()
      execFileSync('diskutil', ['erasevolume', 'HFS+', name, device], { stdio: 'ignore' })
      return {
        path: `/Volumes/${name}`,
        dispose: async () => {
          execFileSync('hdiutil', ['detach', device, '-force'], { stdio: 'ignore' })
        }
      }
    }
    if (process.platform === 'linux') {
      const path = await mkdtemp(join(tmpdir(), 'plexo-vol-'))
      execFileSync('sudo', [
        '-n',
        'mount',
        '-t',
        'tmpfs',
        '-o',
        `size=${megabytes}m`,
        'tmpfs',
        path
      ])
      execFileSync('sudo', ['-n', 'chown', String(process.getuid?.()), path])
      return {
        path,
        dispose: async () => {
          execFileSync('sudo', ['-n', 'umount', path])
          await rm(path, { recursive: true, force: true })
        }
      }
    }
  } catch {
    // No RAM disk tools, or no passwordless sudo — the test skips itself.
  }
  return null
}

test.describe('disk space @disk', () => {
  test('a file bigger than the free space is refused before anything is written', async ({
    plexo,
    serve,
    dirs
  }) => {
    const volume = await smallVolume(10)
    test.skip(!volume, 'cannot create a small volume on this machine')
    try {
      const dest = join(volume!.path, 'dest')
      await mkdir(dest)
      const origin = await serve({ size: 256 * BLOCK }) // 16 MB
      await expect(
        plexo.start(origin.url(), origin.sha256, { destinationDir: dest })
      ).rejects.toThrow(/Not enough disk space/)
      expect(await readdir(dest)).toEqual([])
      const downloads = join(dirs.userData, 'downloads')
      expect(existsSync(downloads) ? await readdir(downloads) : []).toEqual([])
    } finally {
      await plexo.quit()
      await volume!.dispose()
    }
  })

  test('a file that fits once but not twice (file + its parts) is refused upfront', async ({
    serve
  }) => {
    const volume = await smallVolume(12)
    test.skip(!volume, 'cannot create a small volume on this machine')
    // userData on the same small volume, so the part files and the final file compete for it.
    const app = new PlexoApp({
      userData: join(volume!.path, 'userData'),
      dest: join(volume!.path, 'dest')
    })
    try {
      await mkdir(app.dirs.userData)
      await mkdir(app.dirs.dest)
      await app.launch()
      const origin = await serve({ size: 112 * BLOCK }) // 7 MB: fits once, not twice
      // Without counting the parts, this would start, fill the disk while assembling, and
      // fail there — after downloading the whole file.
      await expect(app.start(origin.url(), origin.sha256)).rejects.toThrow(/Not enough disk space/)
      expect(await readdir(app.dirs.dest)).toEqual([])
    } finally {
      if (app.alive) await app.kill()
      await volume!.dispose()
    }
  })
})

test.describe('destination folder problems @smoke', () => {
  // Also the test for assembly write errors: the output stream fails to open, and assembly must
  // surface that instead of waiting forever for a 'drain' that never comes.
  test('destination folder deleted mid-download → error, nothing left', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: 24 * BLOCK })
    const reached = origin.hold(10 * BLOCK)
    await plexo.start(origin.url(), origin.sha256)
    await reached
    await rm(dirs.dest, { recursive: true, force: true })
    origin.release()
    const state = await plexo.waitForStatus(['completed', 'error'])
    expect(state.status).toBe('error')
  })

  test('read-only destination folder → refused, and nothing left in userData', async ({
    plexo,
    serve,
    dirs
  }) => {
    test.skip(process.platform === 'win32', 'chmod does not make a folder read-only on Windows')
    const origin = await serve({ size: 4 * BLOCK })
    await chmod(dirs.dest, 0o555)
    try {
      await expect(plexo.start(origin.url(), origin.sha256)).rejects.toThrow(/EACCES|permission/i)
      const downloads = join(dirs.userData, 'downloads')
      expect(
        existsSync(downloads) ? await readdir(downloads) : [],
        'no orphaned parts folder from the refused start'
      ).toEqual([])
    } finally {
      await chmod(dirs.dest, 0o755)
    }
  })
})
