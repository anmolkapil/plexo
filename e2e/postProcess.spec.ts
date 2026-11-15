import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { NzbPostProcess } from '../src/shared/types'
import {
  isFirstVolume,
  percentIn,
  postProcess,
  volumesOf
} from '../src/main/download/nzb/postProcess'

// What an NZB download's repair and unpacking reads from file names and from what the tools
// print. The tools themselves run in nzb.spec.ts.

test.describe('NZB post-processing @smoke', () => {
  test('unpacks each archive from its first volume', () => {
    const first = [
      'a.rar',
      'b.part01.rar',
      'c.part1.rar',
      'd.part001.rar',
      'e.7z',
      'f.7z.001',
      'g.zip'
    ]
    const rest = ['a.r00', 'b.part02.rar', 'c.part10.rar', 'f.7z.002', 'g.z01', 'h.par2', 'i.mkv']
    expect(first.filter(isFirstVolume)).toEqual(first)
    expect(rest.filter(isFirstVolume)).toEqual([])
  })

  test('an archive’s volumes, and nothing that only shares its name', () => {
    const names = [
      'x.part01.rar',
      'x.part02.rar',
      'x.par2',
      'x.vol0+1.par2',
      'x.nfo',
      'old.rar',
      'old.r00',
      'old.r01',
      'set.7z.001',
      'set.7z.002',
      'setup.exe'
    ]
    expect(volumesOf('x.part01.rar', names)).toEqual(['x.part01.rar', 'x.part02.rar'])
    expect(volumesOf('old.rar', names)).toEqual(['old.rar', 'old.r00', 'old.r01'])
    expect(volumesOf('set.7z.001', names)).toEqual(['set.7z.001', 'set.7z.002'])
  })

  test('the last percentage a tool printed', () => {
    expect(percentIn('Repairing: 12.5%\rRepairing: 47.3%\r')).toBe(47)
    expect(percentIn('  5% 1 - movie.mkv\b\b\b\b 63% 2 - movie.mkv')).toBe(63)
    expect(percentIn('Verifying source files:')).toBeUndefined()
  })
})

test.describe('NZB post-processing, in a folder shared with other files', () => {
  const SEVEN_ZIP = ['7zz', '7z'].find(
    (tool) => spawnSync(tool, ['--help'], { stdio: 'ignore' }).error === undefined
  )

  test('only the NZB’s own archives are unpacked and deleted', async () => {
    test.skip(!SEVEN_ZIP, 'needs 7-Zip')
    const folder = await mkdtemp(join(tmpdir(), 'plexo-pp-'))
    try {
      const pack = (archive: string, file: string): void => {
        execFileSync(SEVEN_ZIP!, ['a', '-mx0', archive, file], { cwd: folder, stdio: 'ignore' })
      }
      await writeFile(join(folder, 'movie.mkv'), 'the release')
      pack('Release.7z', 'movie.mkv')
      await writeFile(join(folder, 'notes.txt'), 'the user’s')
      pack('Mine.7z', 'notes.txt')
      await rm(join(folder, 'movie.mkv'))
      await rm(join(folder, 'notes.txt'))

      const state: NzbPostProcess = {}
      await postProcess({
        folder,
        files: ['Release.7z'],
        missing: 0,
        state,
        changed: () => {},
        checkpoint: async () => {},
        signal: new AbortController().signal
      })
      expect(state).toMatchObject({ unpacked: true, unpackedFiles: ['movie.mkv'] })
      expect((await readdir(folder)).sort()).toEqual(['Mine.7z', 'movie.mkv'])
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  test('a repair leaves other .par2 files alone, and only its own backups go', async () => {
    const par2 = spawnSync('par2', ['-V'], { stdio: 'ignore' }).error === undefined
    test.skip(!par2, 'needs par2')
    const folder = await mkdtemp(join(tmpdir(), 'plexo-pp-'))
    try {
      const run = (...args: string[]): void => {
        execFileSync('par2', args, { cwd: folder, stdio: 'ignore' })
      }
      const movie = randomBytes(64 * 1024)
      await writeFile(join(folder, 'Rel.mkv'), movie)
      run('c', '-s4096', '-r20', '-n1', 'Rel.par2', 'Rel.mkv')
      // The user's: another set beside it, and a file that only looks like one.
      await writeFile(join(folder, 'mine.txt'), 'the user’s')
      run('c', '-s4096', '-r20', '-n1', 'Rel.mine.par2', 'mine.txt')
      await writeFile(join(folder, 'Rel.notes.par2'), 'not a par2 file')
      const own = (await readdir(folder)).filter((name) => /^Rel(\.vol.*)?\.par2$/.test(name))
      const before = (await readdir(folder)).sort()
      // An article that never came: zeros where it belongs.
      const file = await open(join(folder, 'Rel.mkv'), 'r+')
      await file.write(Buffer.alloc(4096), 0, 4096, 8192)
      await file.close()

      const state: NzbPostProcess = {}
      await postProcess({
        folder,
        files: ['Rel.mkv', ...own],
        missing: 1,
        state,
        changed: () => {},
        checkpoint: async () => {},
        signal: new AbortController().signal
      })
      expect(state.repaired).toBe(true)
      expect(await readFile(join(folder, 'Rel.mkv'))).toEqual(movie)
      // No `Rel.mkv.1` left; nothing to unpack, so the download's .par2 files stay too.
      expect((await readdir(folder)).sort()).toEqual(before)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
