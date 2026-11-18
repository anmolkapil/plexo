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
  fc.constantFrom(
    ...['..', '.', '', 'CON', 'con.txt', 'a:b', 'x\u0000y', 'A', 'a', 'dir', 'name. ', 'a|', 'a_'],
    ...['x.', 'x', '...', 'NUL ', 'COM\u00b9.txt', 'a?b', 'a\u0001b', 'dir.', 'Dir', 'DIR.']
  ),
  fc.string({ maxLength: 8 }),
  fc.string({ minLength: 250, maxLength: 300 })
)
const torrentPath = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 4 }), fc.constantFrom('/', '\\'))
  .map(([segments, separator]) => segments.join(separator))
const WINDOWS_CANT_SAVE =
  // eslint-disable-next-line no-control-regex -- Windows can't save control characters
  /[<>:"|?*\u0000-\u001F]|[. ]$|^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

const torrentFiles = fc.array(
  torrentPath.map((path) => ({ path, length: 1 })),
  { minLength: 1, maxLength: 5 }
)

test.describe('torrent paths', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    test(`on ${platform}, a path either stays inside the folder, saveable, or the torrent is refused`, () => {
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
          const keys = checked.map((file) => file.path.normalize('NFC').toLowerCase())
          expect(new Set(keys).size).toBe(keys.length)
          if (platform !== 'win32') return
          // Every name one Windows can save as it is.
          for (const part of checked.flatMap((file) => file.path.split('\\'))) {
            expect(part).not.toMatch(WINDOWS_CANT_SAVE)
          }
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

  test('what climbs out of the folder or collides is refused', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const refused = (paths: string[]): void => {
        const files = paths.map((path) => ({ path, length: 1 }))
        expect(() => safeTorrentPaths(files, platform)).toThrow(UnsafeTorrentError)
      }
      refused(['../evil'])
      refused(['Name/../../evil'])
      refused(['Name/A.txt', 'Name/a.txt'])
      // é composed and decomposed: macOS saves both under one name.
      refused(['Name/caf\u00e9.txt', 'Name/cafe\u0301.txt'])
      refused(['Caf\u00e9/a.txt', 'Cafe\u0301/a.txt'])
      refused(['Name/x', 'Name/x/y'])
      refused([])
    }
    // Names that only start with dots are names.
    expect(safeTorrentPaths([{ path: '..notes.txt', length: 1 }], 'darwin')).toEqual([
      { path: '..notes.txt', length: 1 }
    ])
  })

  /** Where `paths` are saved on `platform`, with "/" between names. */
  const saved = (paths: string[], platform: NodeJS.Platform = 'win32'): string[] =>
    safeTorrentPaths(
      paths.map((path) => ({ path, length: 1 })),
      platform
    ).map((file) => file.path.split(platform === 'win32' ? '\\' : '/').join('/'))

  test('on Windows, a name it can’t save is saved under one it can', () => {
    // #202: the torrent's own name, its folder, has a "|"; or ends in a space.
    const name = '[Trix] Blue Box S01 v3 (WEB 1080p AV1 Opus) [Multi Subs]'
    expect(saved([`${name} | Ao no Hako (VOSTFR) (Batch)/01.mkv`])).toEqual([
      `${name} _ Ao no Hako (VOSTFR) (Batch)/01.mkv`
    ])
    expect(saved([`${name} /01.mkv`, `${name} /02.mkv`])).toEqual([
      `${name}/01.mkv`,
      `${name}/02.mkv`
    ])
    // A folder's forbidden characters, control characters among them, become "_"; a file's are
    // dropped, as webtorrent's storage always has.
    expect(saved(['Name/a:b/c|d?.txt', 'Name/x\u0001y/f'])).toEqual([
      'Name/a_b/cd.txt',
      'Name/x_y/f'
    ])
    // Trailing dots and spaces go; a name of nothing else is "_".
    expect(saved(['Name/Season 1. /notes.', 'Name/report.txt ', 'Name/.../f'])).toEqual([
      'Name/Season 1/notes',
      'Name/report.txt',
      'Name/_/f'
    ])
    expect(saved(['Name/::'])).toEqual(['Name/_'])
    // Device names, with an extension or not, and COM¹/LPT² as COM1 (Win32 file names).
    expect(
      saved([
        'Name/CON.txt',
        'Name/nul',
        'Name/COM\u00b9.txt',
        'Name/LPT\u00b2.txt',
        'Name/AUX ./f'
      ])
    ).toEqual([
      'Name/_CON.txt',
      'Name/_nul',
      'Name/_COM\u00b9.txt',
      'Name/_LPT\u00b2.txt',
      'Name/_AUX/f'
    ])
    expect(saved(['COM\u00b3/file.txt'])).toEqual(['_COM\u00b3/file.txt'])
    // COM10 and an ordinary name that only starts with COM are not device names.
    expect(saved(['Name/COM10.txt', 'Name/COMPANY.txt'])).toEqual([
      'Name/COM10.txt',
      'Name/COMPANY.txt'
    ])
  })

  test('a name renamed into one already in its folder is told apart, the same every time', () => {
    // The name that needn't change keeps it, whichever comes first.
    expect(saved(['Name/x./a', 'Name/x/b'])).toEqual(['Name/x (2)/a', 'Name/x/b'])
    expect(saved(['Name/x', 'Name/x./y'])).toEqual(['Name/x', 'Name/x (2)/y'])
    expect(saved(['Name/report.txt ', 'Name/REPORT.txt'])).toEqual([
      'Name/report (2).txt',
      'Name/REPORT.txt'
    ])
    // Two renamed into one: the first keeps it. A folder is renamed once, for every file in it.
    expect(saved(['Name/a|/1', 'Name/a?/2', 'Name/a|/3'])).toEqual([
      'Name/a_/1',
      'Name/a_ (2)/2',
      'Name/a_/3'
    ])
    // Folders that differ only in case or in how an é is written are one folder on macOS and
    // Windows: a name renamed in one meets the names in the other.
    expect(saved(['Name/Foo/x.', 'Name/foo/x'])).toEqual(['Name/Foo/x (2)', 'Name/foo/x'])
    expect(saved(['Name/Foo/x.', 'Name/foo/x/y'])).toEqual(['Name/Foo/x (2)', 'Name/foo/x/y'])
    expect(saved(['Name/Caf\u00e9/x.', 'Name/Cafe\u0301/x'])).toEqual([
      'Name/Caf\u00e9/x (2)',
      'Name/Cafe\u0301/x'
    ])
    // Folders apart, the same name is no meeting.
    expect(saved(['Name/1/a.', 'Name/2/a'])).toEqual(['Name/1/a', 'Name/2/a'])
    const torrent = ['Name/x./a', 'Name/x/b', 'Name/a.', 'Name/a', 'Name/CON', 'Name/_CON']
    expect(saved(torrent)).toEqual(saved([...torrent]))
    expect(saved(torrent)).toEqual([
      'Name/x (2)/a',
      'Name/x/b',
      'Name/a (2)',
      'Name/a',
      'Name/_CON (2)',
      'Name/_CON'
    ])
  })

  test('elsewhere, the names Windows can’t save are kept', () => {
    const torrent = [
      'Name | Ao/Season 1. /01 | Episode.mkv',
      'Name | Ao/x./a',
      'Name | Ao/x/b',
      'Name | Ao/CON.txt',
      'Name | Ao/COM\u00b9.txt',
      'Name | Ao/a:b/notes. '
    ]
    for (const platform of ['darwin', 'linux'] as const) {
      expect(saved(torrent, platform)).toEqual([
        'Name | Ao/Season 1. /01  Episode.mkv',
        'Name | Ao/x./a',
        'Name | Ao/x/b',
        'Name | Ao/CON.txt',
        'Name | Ao/COM\u00b9.txt',
        'Name | Ao/a:b/notes. '
      ])
    }
  })

  test('a name too long for any file system is shortened, its extension kept', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const long = 'a'.repeat(300)
      const [file, folder, accented, twin] = saved(
        [
          `Name/${long}.mkv`,
          `Name/${'b'.repeat(300)}/f`,
          `Name/${'\u00e9'.repeat(200)}`,
          `Name/${long}x.mkv`
        ],
        platform
      ).map((path) => path.split('/')[1])
      expect(file).toBe(`${'a'.repeat(251)}.mkv`)
      expect(folder).toBe('b'.repeat(255))
      // é is two bytes: 127 of them, not half of one more.
      expect(accented).toBe('\u00e9'.repeat(127))
      // Shortened into the same name as the first: told apart, still in 255 bytes.
      expect(twin).toBe(`${'a'.repeat(247)} (2).mkv`)
    }
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
