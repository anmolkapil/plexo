import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
})
