import { posix, win32 } from 'node:path'

/** What fs-chunk-store (webtorrent's storage) strips from each file's own name before writing it:
 * filename-reserved-regex 3.0.0. Its folders are written as they are. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what it strips
export const STRIPPED_FROM_NAMES = /[<>:"/\\|?*\u0000-\u001F]/g
// Unlike filename-reserved-regex's own check, this also catches the name with an extension:
// Windows reserves CON.txt as well as CON, and the superscript device names COM¹/²/³ and LPT¹/²/³
// the same way as COM1 (see the Win32 "Naming a File" reserved names).
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
// eslint-disable-next-line no-control-regex -- Windows can't save control characters either
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001F]/g
// Windows drops these from the end of a name as it opens one: "Name. " is "Name" there.
const TRAILING_DOTS_AND_SPACES = /[. ]+$/
const MAX_NAME_BYTES = 255
// Longer than any real extension (as in claimName): past this, what follows the last dot is part
// of the name, shortened along with the rest.
const MAX_EXTENSION_BYTES = 32

export class UnsafeTorrentError extends Error {}

/**
 * Where webtorrent will write each of a torrent's files, relative to the folder it's handed, or an
 * UnsafeTorrentError when any file could land outside that folder or collide with another. A
 * torrent's paths come from whoever made it: every torrent is checked before anything is written.
 *
 * A name this system can't save is saved under one it can, as other torrent clients do: on
 * Windows a folder's forbidden characters become "_" (a file's own are dropped, as webtorrent's
 * storage always has), a trailing dot or space goes, and a device name gets a "_" in front, as
 * claimName and NZB downloads do ("CON.txt" is saved as "_CON.txt"). A name too long for any file
 * system is shortened, its extension kept. The storage is handed these paths (see storeNamed), so
 * they are where the files are; and as they're worked out from the torrent alone, a download
 * resumed or relaunched finds its pieces where it left them.
 */
export function safeTorrentPaths(
  files: readonly { path: string; length: number }[],
  platform: NodeJS.Platform = process.platform
): { path: string; length: number }[] {
  if (files.length === 0) throw new UnsafeTorrentError('This torrent has no files')
  const path = platform === 'win32' ? win32 : posix
  const base = path.resolve(path.sep, 'staging')
  const checked = files.map((file) => {
    // Nothing left of it: saved as "_", which saveable gives any name left empty.
    const name = path.basename(file.path).replace(STRIPPED_FROM_NAMES, '') || '_'
    // fs-chunk-store: resolve(join(folder, dirname(path))), then the cleaned name.
    const target = path.join(path.resolve(path.join(base, path.dirname(file.path))), name)
    const relative = path.relative(base, target)
    const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`)
    if (!relative || climbsOut || path.isAbsolute(relative)) {
      throw new UnsafeTorrentError(`This torrent has a file Plexo can't save safely: ${file.path}`)
    }
    return { path: relative, length: file.length }
  })

  // The torrent's own names first: two that only the renaming makes one are told apart there
  // instead (see savedNames). What it saves is checked again all the same.
  const named = checked.map((file) => file.path.split(path.sep))
  refuseCollisions(named)
  const saved = savedNames(named, platform)
  refuseCollisions(saved)
  return checked.map((file, index) => ({ path: saved[index].join(path.sep), length: file.length }))
}

/**
 * Refuses paths that would be saved as one file, compared without case: macOS and Windows treat
 * "A.txt" and "a.txt" as one file, and macOS treats an é composed or decomposed as one too. A file
 * can't also be a folder another file sits in.
 */
function refuseCollisions(paths: readonly string[][]): void {
  const keys = paths.map((segments) => key(segments.join('/')))
  const taken = new Set(keys)
  if (taken.size !== keys.length) {
    throw new UnsafeTorrentError('Two files in this torrent would be saved as the same file')
  }
  for (const segments of paths) {
    for (let end = 1; end < segments.length; end++) {
      if (taken.has(key(segments.slice(0, end).join('/')))) {
        throw new UnsafeTorrentError('A file in this torrent has the same name as a folder in it')
      }
    }
  }
}

/** How names are compared: without case, and an é composed or decomposed as one. */
const key = (name: string): string => name.normalize('NFC').toLowerCase()

/**
 * Each file's path, as segments, with every name as this system can save it (see saveable). A
 * name that had to change and so meets another in its folder, a file's or a folder's, is told
 * apart as "Name (2)": the names that didn't change keep theirs. Each folder is renamed once, so
 * every file in it goes to the same place. Worked out from the torrent alone, in its files' order:
 * the same every time.
 */
function savedNames(paths: readonly string[][], platform: NodeJS.Platform): string[][] {
  const saved = paths.map(() => [] as string[])
  // What each file or folder is saved as, by the torrent's own path to it. Segments never hold a
  // "/" (the separator on macOS and Linux; on Windows a path's are all "\").
  const renamed = new Map<string, string>()
  // The names in each folder so far, by its path as saved, compared as names are: "Foo" and "foo"
  // are one folder on macOS and Windows.
  const used = new Map<string, Set<string>>()
  const depth = paths.reduce((deepest, segments) => Math.max(deepest, segments.length), 0)
  for (let level = 0; level < depth; level++) {
    // Each file or folder at this level once, in the torrent's order.
    const entries = new Map<string, { name: string; isFile: boolean; parent: string }>()
    paths.forEach((segments, index) => {
      if (level >= segments.length) return
      const original = segments.slice(0, level + 1).join('/')
      if (entries.has(original)) return
      const isFile = level === segments.length - 1
      entries.set(original, { name: segments[level], isFile, parent: saved[index].join('/') })
    })
    const named = [...entries].map(([original, entry]) => ({
      original,
      ...entry,
      saveAs: saveable(entry.name, entry.isFile, platform)
    }))
    // Those that keep their names first, so one renamed gives way to them.
    const keeping = named.filter((entry) => entry.saveAs === entry.name)
    const renaming = named.filter((entry) => entry.saveAs !== entry.name)
    for (const entry of [...keeping, ...renaming]) {
      const folder = key(entry.parent)
      const names = used.get(folder) ?? new Set<string>()
      used.set(folder, names)
      let name = entry.saveAs
      if (name !== entry.name) {
        for (let count = 2; names.has(key(name)); count++) {
          name = shortened(entry.saveAs, entry.isFile, ` (${count})`, platform)
        }
      }
      names.add(key(name))
      renamed.set(entry.original, name)
    }
    paths.forEach((segments, index) => {
      if (level < segments.length) {
        saved[index].push(renamed.get(segments.slice(0, level + 1).join('/'))!)
      }
    })
  }
  return saved
}

/** `name` as this system can save it: itself, when it can. */
function saveable(name: string, isFile: boolean, platform: NodeJS.Platform): string {
  // A file's own name has had these dropped already, as fs-chunk-store drops them, but for one the
  // torrent names "Folder/..", which is "Folder" in the end.
  let fixed = platform === 'win32' ? name.replace(WINDOWS_FORBIDDEN, '_') : name
  fixed = shortened(fixed, isFile, '', platform)
  if (platform === 'win32' && WINDOWS_RESERVED.test(fixed)) {
    fixed = shortened(`_${fixed}`, isFile, '', platform)
  }
  return fixed
}

/**
 * `name` with `suffix` added (before a file's extension), shortened to fit in MAX_NAME_BYTES with
 * its extension kept, with nothing at its end that Windows would drop, and never empty.
 */
function shortened(
  name: string,
  isFile: boolean,
  suffix: string,
  platform: NodeJS.Platform
): string {
  const trim = (text: string): string =>
    platform === 'win32' ? text.replace(TRAILING_DOTS_AND_SPACES, '') : text
  const whole = trim(name) || '_'
  const dot = whole.lastIndexOf('.')
  const extension =
    isFile && dot > 0 && Buffer.byteLength(whole.slice(dot)) <= MAX_EXTENSION_BYTES
      ? whole.slice(dot)
      : ''
  const characters = Array.from(whole.slice(0, whole.length - extension.length))
  while (Buffer.byteLength(characters.join('') + suffix + extension) > MAX_NAME_BYTES) {
    characters.pop()
  }
  return trim(characters.join('') + suffix + extension) || '_'
}
