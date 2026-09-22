import type { TorrentMetadata } from '../../shared/types'
import type { ResolvedMetadata } from './metadata'
import type { TorrentInfo } from './torrentInfo'

// Resolving metadata means finding a peer willing to serve it, which takes seconds and can
// fail outright. The probe already paid that cost, so starting the download it described
// should not have to pay it again — this is what bridges the two.
//
// Bounded because each entry holds a torrent's full piece-hash list, and a user pasting one
// magnet after another would otherwise accumulate all of them for the life of the process.
const MAX_CACHED_TORRENTS = 8

/** Display cap on the file list sent to the renderer. A torrent with tens of thousands of
 * files would otherwise push a megabyte of paths through IPC on every probe, to render a
 * list nobody scrolls to the end of. */
const MAX_LISTED_FILES = 500

const cache = new Map<string, ResolvedMetadata>()

export function rememberMetadata(infoHashHex: string, resolved: ResolvedMetadata): void {
  // Re-inserting moves the key to the end, so the eviction below is least-recently-used.
  cache.delete(infoHashHex)
  cache.set(infoHashHex, resolved)

  while (cache.size > MAX_CACHED_TORRENTS) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

export function recallMetadata(infoHashHex: string): ResolvedMetadata | null {
  const resolved = cache.get(infoHashHex)
  if (!resolved) return null
  rememberMetadata(infoHashHex, resolved)
  return resolved
}

/** Projects parsed metadata down to the serializable shape the renderer consumes. */
export function toTorrentMetadata(info: TorrentInfo, infoHashHex: string): TorrentMetadata {
  return {
    infoHashHex,
    pieceCount: info.pieceHashes.length,
    pieceLengthBytes: info.pieceLength,
    isSingleFile: info.isSingleFile,
    files: info.files.slice(0, MAX_LISTED_FILES).map((file) => ({
      path: file.path.join('/'),
      length: file.length
    }))
  }
}
