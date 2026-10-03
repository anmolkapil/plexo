import { posix, win32 } from 'node:path'

/** What fs-chunk-store (webtorrent's storage) strips from each file's own name before writing it:
 * filename-reserved-regex 3.0.0. Its folders are written as they are. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what it strips
export const STRIPPED_FROM_NAMES = /[<>:"/\\|?*\u0000-\u001F]/g
// Unlike filename-reserved-regex's own check, this also catches the name with an extension:
// Windows reserves CON.txt as well as CON.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
// eslint-disable-next-line no-control-regex -- Windows can't save control characters either
const WINDOWS_INVALID = /[<>:"|?*\u0000-\u001F]|[. ]$/
const MAX_NAME_BYTES = 255

export class UnsafeTorrentError extends Error {}

/**
 * Where webtorrent will write each of a torrent's files, relative to the folder it's handed —
 * worked out exactly as fs-chunk-store does it — or an UnsafeTorrentError when any file could
 * land outside that folder, collide with another, or can't be written on this system. A
 * torrent's paths come from whoever made it: every torrent is checked before anything is written.
 */
export function safeTorrentPaths(
  files: readonly { path: string; length: number }[],
  platform: NodeJS.Platform = process.platform
): { path: string; length: number }[] {
  if (files.length === 0) throw new UnsafeTorrentError('This torrent has no files')
  const path = platform === 'win32' ? win32 : posix
  const base = path.resolve(path.sep, 'staging')
  const checked = files.map((file) => {
    const name = path.basename(file.path).replace(STRIPPED_FROM_NAMES, '')
    // fs-chunk-store: resolve(join(folder, dirname(path))), then the cleaned name.
    const target = path.join(path.resolve(path.join(base, path.dirname(file.path))), name)
    const relative = path.relative(base, target)
    const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`)
    if (!name || !relative || climbsOut || path.isAbsolute(relative)) {
      throw new UnsafeTorrentError(`This torrent has a file Plexo can't save safely: ${file.path}`)
    }
    for (const segment of relative.split(path.sep)) {
      if (Buffer.byteLength(segment) > MAX_NAME_BYTES) {
        throw new UnsafeTorrentError(`A name in this torrent is too long to save: ${segment}`)
      }
      if (
        platform === 'win32' &&
        (WINDOWS_RESERVED.test(segment) || WINDOWS_INVALID.test(segment))
      ) {
        throw new UnsafeTorrentError(`Windows can't save a file named ${segment}`)
      }
    }
    return { path: relative, length: file.length }
  })

  // Compared without case: macOS and Windows treat "A.txt" and "a.txt" as one file. A file can't
  // also be a folder another file sits in.
  const taken = new Set(checked.map((file) => file.path.toLowerCase()))
  if (taken.size !== checked.length) {
    throw new UnsafeTorrentError('Two files in this torrent would be saved as the same file')
  }
  for (const file of checked) {
    const segments = file.path.toLowerCase().split(path.sep)
    for (let end = 1; end < segments.length; end++) {
      if (taken.has(segments.slice(0, end).join(path.sep))) {
        throw new UnsafeTorrentError('A file in this torrent has the same name as a folder in it')
      }
    }
  }
  return checked
}
