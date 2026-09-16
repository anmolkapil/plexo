import { URL } from 'node:url'

export interface MagnetLink {
  /** The magnet URI as entered, kept so a download can be persisted and resumed from it. */
  uri: string
  /** The 20-byte BitTorrent v1 infohash. */
  infoHash: Buffer
  infoHashHex: string
  /** `dn` — a display hint only. The real name comes from the metadata, so this is never
   * used as a file name on its own. */
  displayName: string | null
  /** `tr` — announce URLs, in the order the link listed them. */
  trackers: string[]
  /** `ws` — HTTP/FTP sources for the same content (BEP 19). */
  webSeeds: string[]
  /** `xl` — the advertised size. A hint for the UI before metadata arrives; the metadata's
   * own length is what the download actually trusts. */
  exactLength: number | null
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const HEX_INFOHASH_LENGTH = 40
const BASE32_INFOHASH_LENGTH = 32
const INFOHASH_BYTES = 20

/** Cheap enough to call on every keystroke — this is what routes input to the torrent path
 * instead of the HTTP probe, so it only looks at the scheme. */
export function isMagnetUri(raw: string): boolean {
  return /^magnet:\?/i.test(raw.trim())
}

/** RFC 4648 base32, unpadded — the form BEP 9 allows for an `xt` infohash. */
function decodeBase32(text: string): Buffer {
  const bytes: number[] = []
  let accumulator = 0
  let bitsHeld = 0

  for (const character of text.toUpperCase()) {
    const value = BASE32_ALPHABET.indexOf(character)
    if (value < 0) throw new Error(`Invalid base32 character "${character}" in magnet infohash`)

    accumulator = (accumulator << 5) | value
    bitsHeld += 5
    if (bitsHeld >= 8) {
      bitsHeld -= 8
      bytes.push((accumulator >>> bitsHeld) & 0xff)
    }
  }

  return Buffer.from(bytes)
}

function parseInfoHash(exactTopic: string): Buffer {
  const btih = /^urn:btih:([0-9a-z]+)$/i.exec(exactTopic)
  if (!btih) {
    // A v2-only link identifies its torrent by a SHA-256 multihash, which needs the v2
    // metadata format and merkle piece layout end to end — better to say so than to fail
    // later with a confusing hash mismatch.
    if (/^urn:btmh:/i.test(exactTopic)) {
      throw new Error('This is a BitTorrent v2 magnet link, which Plexo does not support yet')
    }
    throw new Error('Magnet link has no recognizable BitTorrent infohash (expected urn:btih:)')
  }

  const hash = btih[1]
  if (hash.length === HEX_INFOHASH_LENGTH) {
    if (!/^[0-9a-f]+$/i.test(hash)) throw new Error('Magnet infohash is not valid hex')
    return Buffer.from(hash, 'hex')
  }

  if (hash.length === BASE32_INFOHASH_LENGTH) {
    const decoded = decodeBase32(hash)
    if (decoded.length !== INFOHASH_BYTES) throw new Error('Magnet infohash has the wrong length')
    return decoded
  }

  throw new Error(
    `Magnet infohash is ${hash.length} characters; expected ${HEX_INFOHASH_LENGTH} (hex) or ${BASE32_INFOHASH_LENGTH} (base32)`
  )
}

/** Keeps only announce schemes the tracker client can actually speak. */
function isSupportedTracker(raw: string): boolean {
  return /^(https?|udp):\/\//i.test(raw)
}

/**
 * Parses a magnet URI into the pieces needed to start a torrent, throwing a message fit to
 * show the user when the link can't be used.
 *
 * Only `xt` is required: a link with no trackers is still valid and still worth accepting,
 * since the fallback tracker list can supply peers for it.
 */
export function parseMagnetUri(raw: string): MagnetLink {
  const uri = raw.trim()
  if (!isMagnetUri(uri)) throw new Error('Not a magnet link')

  let params: URLSearchParams
  try {
    params = new URL(uri).searchParams
  } catch {
    throw new Error('Magnet link is not a valid URI')
  }

  const exactTopic = params.getAll('xt').find((topic) => /^urn:bt(ih|mh):/i.test(topic))
  if (!exactTopic) throw new Error('Magnet link is missing its "xt" infohash parameter')

  const infoHash = parseInfoHash(exactTopic)
  const displayName = params.get('dn')?.trim()
  const exactLength = Number(params.get('xl'))

  return {
    uri,
    infoHash,
    infoHashHex: infoHash.toString('hex'),
    displayName: displayName ? displayName : null,
    trackers: params.getAll('tr').filter(isSupportedTracker),
    webSeeds: params.getAll('ws').filter((seed) => /^https?:\/\//i.test(seed)),
    exactLength: Number.isSafeInteger(exactLength) && exactLength > 0 ? exactLength : null
  }
}
