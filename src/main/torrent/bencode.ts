/** A decoded bencode value. Byte strings stay `Buffer`s rather than becoming strings:
 * torrent metadata mixes UTF-8 text (file names) with raw binary (piece hashes, compact
 * peer lists) under one bencode type, so decoding every byte string as text would quietly
 * corrupt the binary ones. */
export type BencodeValue = number | Buffer | BencodeValue[] | BencodeDict

export interface BencodeDict {
  [key: string]: BencodeValue
}

/** Accepted by `encode`, which also takes plain strings as a convenience. The decoder never
 * produces them — see `BencodeValue`. */
export type BencodeInput = number | string | Buffer | BencodeInput[] | BencodeInputDict

export interface BencodeInputDict {
  [key: string]: BencodeInput
}

// Everything decoded here arrives from an untrusted tracker or peer, so each step is
// bounded. A hostile or truncated payload should throw a plain error rather than recurse
// until the stack gives out or allocate against an attacker-chosen length.
const MAX_DEPTH = 32

const CHAR_0 = 0x30
const CHAR_9 = 0x39
const CHAR_COLON = 0x3a
const CHAR_D = 0x64
const CHAR_E = 0x65
const CHAR_I = 0x69
const CHAR_L = 0x6c

interface Reader {
  buffer: Buffer
  offset: number
}

function expect(reader: Reader, byte: number, what: string): void {
  if (reader.buffer[reader.offset] !== byte) {
    throw new Error(`Malformed bencode: expected ${what} at byte ${reader.offset}`)
  }
  reader.offset += 1
}

/** Reads the digits (plus an optional leading `-`) that run up to `terminator`. */
function readNumber(reader: Reader, terminator: number): number {
  const start = reader.offset
  const end = reader.buffer.indexOf(terminator, start)
  if (end < 0) throw new Error('Malformed bencode: unterminated number')

  const text = reader.buffer.toString('latin1', start, end)
  if (!/^-?\d+$/.test(text)) throw new Error(`Malformed bencode: "${text}" is not an integer`)

  const value = Number(text)
  // Piece lengths and file sizes are used for offsets and allocations, so a value that
  // can't survive JS integer arithmetic has to be rejected rather than silently rounded.
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Malformed bencode: integer ${text} is out of safe range`)
  }

  reader.offset = end + 1
  return value
}

function decodeInteger(reader: Reader): number {
  expect(reader, CHAR_I, 'integer')
  return readNumber(reader, CHAR_E)
}

function decodeBytes(reader: Reader): Buffer {
  const length = readNumber(reader, CHAR_COLON)
  if (length < 0) throw new Error('Malformed bencode: negative byte-string length')

  const end = reader.offset + length
  if (end > reader.buffer.length) {
    throw new Error(`Malformed bencode: byte string of ${length} runs past end of input`)
  }

  // Copied rather than sliced: a subarray keeps the whole received payload alive for as long
  // as any piece hash or file name taken from it is referenced.
  const bytes = Buffer.from(reader.buffer.subarray(reader.offset, end))
  reader.offset = end
  return bytes
}

function decodeList(reader: Reader, depth: number): BencodeValue[] {
  expect(reader, CHAR_L, 'list')
  const values: BencodeValue[] = []
  while (reader.buffer[reader.offset] !== CHAR_E) {
    values.push(decodeValue(reader, depth + 1))
  }
  reader.offset += 1
  return values
}

function decodeDict(reader: Reader, depth: number): BencodeDict {
  expect(reader, CHAR_D, 'dictionary')
  const dict: BencodeDict = {}
  while (reader.buffer[reader.offset] !== CHAR_E) {
    const key = decodeBytes(reader)
    dict[key.toString('utf-8')] = decodeValue(reader, depth + 1)
  }
  reader.offset += 1
  return dict
}

function decodeValue(reader: Reader, depth: number): BencodeValue {
  if (depth > MAX_DEPTH) throw new Error('Malformed bencode: nested too deeply')
  if (reader.offset >= reader.buffer.length) throw new Error('Malformed bencode: truncated')

  const marker = reader.buffer[reader.offset]
  if (marker === CHAR_I) return decodeInteger(reader)
  if (marker === CHAR_L) return decodeList(reader, depth)
  if (marker === CHAR_D) return decodeDict(reader, depth)
  if (marker >= CHAR_0 && marker <= CHAR_9) return decodeBytes(reader)

  throw new Error(`Malformed bencode: unexpected byte 0x${marker.toString(16)}`)
}

/**
 * Decodes one bencode value from the front of `buffer`, reporting how many bytes it used.
 *
 * The byte count is not incidental: a BEP 9 metadata message is a bencoded header
 * immediately followed by raw (un-bencoded) payload bytes, so the only way to find where
 * that payload starts is to be told where the header ended.
 */
export function decodePrefix(buffer: Buffer): { value: BencodeValue; bytesRead: number } {
  const reader: Reader = { buffer, offset: 0 }
  const value = decodeValue(reader, 0)
  return { value, bytesRead: reader.offset }
}

/** Decodes a buffer that must contain exactly one bencode value and nothing after it. */
export function decode(buffer: Buffer): BencodeValue {
  const { value, bytesRead } = decodePrefix(buffer)
  if (bytesRead !== buffer.length) {
    throw new Error(`Malformed bencode: ${buffer.length - bytesRead} trailing bytes`)
  }
  return value
}

export function encode(value: BencodeInput): Buffer {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Cannot bencode non-integer ${value}`)
    return Buffer.from(`i${value}e`, 'latin1')
  }

  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf-8')
    return Buffer.concat([Buffer.from(`${bytes.length}:`, 'latin1'), bytes])
  }

  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from('l', 'latin1'), ...value.map(encode), Buffer.from('e')])
  }

  // Bencode requires dictionary keys in lexicographic byte order. Peers reject a
  // handshake that gets this wrong, and for anything hashed (an info dict) the key order
  // is part of the infohash, so it can't be left to insertion order.
  const parts = Object.keys(value)
    .sort()
    .map((key) => Buffer.concat([encode(key), encode(value[key])]))
  return Buffer.concat([Buffer.from('d', 'latin1'), ...parts, Buffer.from('e')])
}

/** Reads `key` from a dict as a byte string, or null when absent or of the wrong type. */
export function dictBytes(dict: BencodeDict, key: string): Buffer | null {
  const value = dict[key]
  return Buffer.isBuffer(value) ? value : null
}

/** Reads `key` from a dict as an integer, or null when absent or of the wrong type. */
export function dictNumber(dict: BencodeDict, key: string): number | null {
  const value = dict[key]
  return typeof value === 'number' ? value : null
}

export function isDict(value: BencodeValue | undefined): value is BencodeDict {
  return (
    typeof value === 'object' && value !== null && !Buffer.isBuffer(value) && !Array.isArray(value)
  )
}
