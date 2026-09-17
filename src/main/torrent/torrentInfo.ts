import { createHash } from 'node:crypto'
import { decode, dictBytes, dictNumber, isDict, type BencodeDict } from './bencode'

export interface TorrentFileEntry {
  /** Path segments relative to the torrent root, already sanitized — see `parseFiles`. */
  path: string[]
  length: number
  /** Byte offset of this file within the torrent's concatenated piece stream. */
  offset: number
}

export interface TorrentInfo {
  /** The torrent's own name: the file name for a single-file torrent, the directory name
   * for a multi-file one. */
  name: string
  pieceLength: number
  /** One 20-byte SHA-1 per piece, in piece order. */
  pieceHashes: Buffer[]
  totalLength: number
  files: TorrentFileEntry[]
  /** true when the torrent holds exactly one file at its root (`info.length`) rather than a
   * directory of them (`info.files`). */
  isSingleFile: boolean
}

const PIECE_HASH_BYTES = 20

// A torrent's own metadata is allowed to be large, but an info dict this big is either
// broken or hostile, and it has to be held in memory to be hashed.
const MAX_METADATA_BYTES = 8 * 1024 * 1024

/** Strips a path segment supplied by a torrent down to something safe to join onto a
 * destination directory. Segment names are attacker-controlled, so traversal (`..`), absolute
 * roots and separators have to come out before the path is ever built. */
function sanitizeSegment(segment: string): string {
  const safe = segment
    .replace(/[\\/]/g, '_')
    .replace(/\p{Cc}/gu, '_')
    .trim()
  return !safe || /^\.+$/.test(safe) ? '_' : safe
}

function parseFiles(info: BencodeDict, name: string): { files: TorrentFileEntry[]; total: number } {
  const singleLength = dictNumber(info, 'length')

  if (singleLength !== null) {
    if (singleLength < 0) throw new Error('Torrent metadata declares a negative file length')
    return {
      files: [{ path: [sanitizeSegment(name)], length: singleLength, offset: 0 }],
      total: singleLength
    }
  }

  const rawFiles = info['files']
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new Error('Torrent metadata has neither a "length" nor a non-empty "files" list')
  }

  const files: TorrentFileEntry[] = []
  let offset = 0

  for (const entry of rawFiles) {
    if (!isDict(entry)) throw new Error('Torrent metadata has a malformed entry in "files"')

    const length = dictNumber(entry, 'length')
    if (length === null || length < 0) {
      throw new Error('Torrent metadata has a file with no valid length')
    }

    const rawPath = entry['path']
    if (!Array.isArray(rawPath) || rawPath.length === 0) {
      throw new Error('Torrent metadata has a file with no path')
    }

    const segments = rawPath.map((segment) => {
      if (!Buffer.isBuffer(segment)) throw new Error('Torrent file path is not a byte string')
      return sanitizeSegment(segment.toString('utf-8'))
    })

    files.push({ path: segments, length, offset })
    offset += length
  }

  return { files, total: offset }
}

/**
 * Parses a bencoded info dictionary into the shape a download needs, after proving it is the
 * dictionary we asked for.
 *
 * The hash check is the whole security model of a magnet link. `raw` arrives from an
 * untrusted peer, and everything downstream — piece hashes, file names, lengths — is taken
 * on its word, so a blob whose SHA-1 isn't the infohash from the link has to be rejected
 * outright rather than merely distrusted.
 */
export function parseInfoDict(raw: Buffer, expectedInfoHash: Buffer): TorrentInfo {
  if (raw.length === 0) throw new Error('Torrent metadata is empty')
  if (raw.length > MAX_METADATA_BYTES) {
    throw new Error(`Torrent metadata is ${raw.length} bytes, which is implausibly large`)
  }

  const actualInfoHash = createHash('sha1').update(raw).digest()
  if (!actualInfoHash.equals(expectedInfoHash)) {
    throw new Error(
      `Torrent metadata does not match the magnet link's infohash (got ${actualInfoHash.toString('hex')})`
    )
  }

  const info = decode(raw)
  if (!isDict(info)) throw new Error('Torrent metadata is not a dictionary')

  const nameBytes = dictBytes(info, 'name')
  if (!nameBytes) throw new Error('Torrent metadata has no name')
  const name = nameBytes.toString('utf-8')

  const pieceLength = dictNumber(info, 'piece length')
  if (pieceLength === null || pieceLength <= 0) {
    throw new Error('Torrent metadata has no valid piece length')
  }

  const pieces = dictBytes(info, 'pieces')
  if (!pieces || pieces.length === 0 || pieces.length % PIECE_HASH_BYTES !== 0) {
    throw new Error('Torrent metadata has a malformed piece-hash list')
  }

  const pieceHashes: Buffer[] = []
  for (let offset = 0; offset < pieces.length; offset += PIECE_HASH_BYTES) {
    pieceHashes.push(pieces.subarray(offset, offset + PIECE_HASH_BYTES))
  }

  const { files, total } = parseFiles(info, name)
  if (total <= 0) throw new Error('Torrent metadata describes an empty download')

  // The piece count is redundant with the total length, which makes it a free consistency
  // check — and one worth making, because these two are what every offset below is derived
  // from. Disagreement here would land bytes at the wrong place in the output.
  const expectedPieces = Math.ceil(total / pieceLength)
  if (pieceHashes.length !== expectedPieces) {
    throw new Error(
      `Torrent metadata is inconsistent: ${pieceHashes.length} piece hashes for ${expectedPieces} pieces`
    )
  }

  return {
    name,
    pieceLength,
    pieceHashes,
    totalLength: total,
    files,
    isSingleFile: dictNumber(info, 'length') !== null
  }
}

/** Length of piece `index` — every piece is `pieceLength` except the last, which is short
 * unless the total happens to divide evenly. */
export function pieceLengthAt(info: TorrentInfo, index: number): number {
  const start = index * info.pieceLength
  return Math.min(info.pieceLength, info.totalLength - start)
}
