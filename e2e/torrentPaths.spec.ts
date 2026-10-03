import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { posix, win32 } from 'node:path'
import {
  safeTorrentPaths,
  STRIPPED_FROM_NAMES,
  UnsafeTorrentError
} from '../src/main/download/torrent/paths'

// What a torrent can put in a path: anything, including what tries to climb out of the folder,
// what Windows can't save, and names too long for any file system.
const segment = fc.oneof(
  fc.constantFrom('..', '.', '', 'CON', 'con.txt', 'a:b', 'x\u0000y', 'A', 'a', 'dir', 'name. '),
  fc.string({ maxLength: 8 }),
  fc.string({ minLength: 250, maxLength: 300 })
)
const torrentPath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.constantFrom('/', '\\'))
  .map(([segments, separator]) => segments.join(separator))
const torrentFiles = fc.array(
  torrentPath.map((path) => ({ path, length: 1 })),
  { minLength: 1, maxLength: 5 }
)

test.describe('torrent paths', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    test(`on ${platform}, a path either stays inside the folder or the torrent is refused`, () => {
      const path = platform === 'win32' ? win32 : posix
      const base = path.resolve(path.sep, 'staging')
      fc.assert(
        fc.property(torrentFiles, (files) => {
          let checked: { path: string }[]
          try {
            checked = safeTorrentPaths(files, platform)
          } catch (error) {
            expect(error).toBeInstanceOf(UnsafeTorrentError)
            return
          }
          for (const file of checked) {
            expect(path.isAbsolute(file.path)).toBe(false)
            expect(path.resolve(base, file.path).startsWith(base + path.sep)).toBe(true)
            for (const part of file.path.split(path.sep)) {
              expect(['', '.', '..']).not.toContain(part)
              expect(Buffer.byteLength(part)).toBeLessThanOrEqual(255)
            }
          }
          const lowered = checked.map((file) => file.path.toLowerCase())
          expect(new Set(lowered).size).toBe(lowered.length)
        }),
        { numRuns: 500 }
      )
    })
  }

  test('an ordinary multi-file torrent keeps its layout', () => {
    const files = [
      { path: 'Album/01 - Intro.flac', length: 10 },
      { path: 'Album/Art/cover.jpg', length: 5 }
    ]
    expect(safeTorrentPaths(files, 'darwin')).toEqual(files)
    expect(safeTorrentPaths(files, 'win32').map((file) => file.path)).toEqual([
      'Album\\01 - Intro.flac',
      'Album\\Art\\cover.jpg'
    ])
  })

  test('what climbs out of the folder, collides, or Windows reserves is refused', () => {
    const refused = (paths: string[], platform: NodeJS.Platform = 'darwin'): void => {
      const files = paths.map((path) => ({ path, length: 1 }))
      expect(() => safeTorrentPaths(files, platform)).toThrow(UnsafeTorrentError)
    }
    refused(['../evil'])
    refused(['Name/../../evil'])
    refused(['Name/A.txt', 'Name/a.txt'])
    refused(['Name/x', 'Name/x/y'])
    refused(['Name/::'])
    refused(['Name/CON.txt'], 'win32')
    refused(['Name/a:b/file'], 'win32')
    refused([])
    // The same names are fine where nothing reserves them, as are names that only start with dots.
    expect(safeTorrentPaths([{ path: 'Name/CON.txt', length: 1 }], 'darwin')).toHaveLength(1)
    expect(safeTorrentPaths([{ path: '..notes.txt', length: 1 }], 'darwin')).toEqual([
      { path: '..notes.txt', length: 1 }
    ])
  })

  test('names are cleaned the way webtorrent’s storage cleans them', async () => {
    // fs-chunk-store's own regex, as installed: an upgrade that changes it fails here. (ESM-only,
    // so through import(), as specs load such packages.)
    const { default: filenameReservedRegex } = (await import(
      'filename-reserved-regex' as string
    )) as { default: () => RegExp }
    expect(STRIPPED_FROM_NAMES.source).toBe(filenameReservedRegex().source)
    expect(safeTorrentPaths([{ path: 'Name/a:b?.txt', length: 1 }], 'darwin')).toEqual([
      { path: 'Name/ab.txt', length: 1 }
    ])
  })
})
