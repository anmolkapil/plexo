import { crc32 } from 'node:zlib'

/** An article's body that isn't the yEnc it should be, or whose bytes don't match its checksum:
 * the article is damaged, whichever server sent it. */
export class YencError extends Error {}

/** One decoded article: part of a file, and where in that file it goes. */
export interface YencPart {
  /** The file's name, as the poster's yEnc header gives it. */
  name: string
  /** The whole file's size. */
  fileSize: number
  /** Where `data` goes in the file, from its first byte. */
  offset: number
  data: Buffer
}

const CR = 0x0d
const LF = 0x0a
const ESCAPE = 0x3d // '='

/** A header line's `key=value` fields. `name` runs to the end of the line, spaces and all, so
 * it is taken apart from the rest. */
function fields(line: string): Map<string, string> {
  const found = new Map<string, string>()
  const nameAt = line.search(/\bname=/)
  const head = nameAt >= 0 ? line.slice(0, nameAt) : line
  if (nameAt >= 0) found.set('name', line.slice(nameAt + 5).trim())
  for (const match of head.matchAll(/(\w+)=(\S*)/g)) found.set(match[1], match[2])
  return found
}

function count(value: string | undefined, what: string): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new YencError(`This article's yEnc header has no valid ${what}`)
  }
  return parsed
}

/** The CRC-32 a trailer gives, if it gives one: some posters leave it out. */
function checksum(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9a-f]{1,8}$/i.test(value)) return undefined
  return parseInt(value, 16)
}

/**
 * Decodes one article's body (already dot-unstuffed, see nntp.ts) as yEnc: the `=ybegin` line,
 * `=ypart` for an article that is part of a larger file, the data lines, and `=yend`. Anything
 * before `=ybegin` is ignored, as decoders do. The data's length and CRC-32 are checked against
 * the trailer, so a damaged article is never written as if it were good.
 */
export function decodeYenc(body: Buffer): YencPart {
  let position = 0
  const nextLine = (): Buffer | null => {
    if (position >= body.length) return null
    let end = body.indexOf(LF, position)
    if (end < 0) end = body.length
    const line = body.subarray(position, end > position && body[end - 1] === CR ? end - 1 : end)
    position = end + 1
    return line
  }

  let line = nextLine()
  while (line && !line.subarray(0, 8).equals(Buffer.from('=ybegin '))) line = nextLine()
  if (!line) throw new YencError('This article isn’t yEnc-encoded')
  // The name is the poster's bytes: UTF-8 when it's anything readable at all.
  const begin = fields(line.toString('utf8'))
  const fileSize = count(begin.get('size'), 'file size')
  const name = begin.get('name') ?? ''

  let offset = 0
  let expected = fileSize
  if (begin.has('part')) {
    const partLine = nextLine()
    if (!partLine?.subarray(0, 7).equals(Buffer.from('=ypart '))) {
      throw new YencError('This article’s yEnc part header is missing')
    }
    const part = fields(partLine.toString('latin1'))
    const first = count(part.get('begin'), 'part start')
    const last = count(part.get('end'), 'part end')
    if (first < 1 || last < first || last > fileSize) {
      throw new YencError('This article’s yEnc part lies outside its file')
    }
    offset = first - 1
    expected = last - first + 1
  }

  // Decoded data is never longer than what encodes it.
  const data = Buffer.allocUnsafe(Math.min(expected, body.length - position))
  let length = 0
  let trailer: Map<string, string> | null = null
  while ((line = nextLine()) !== null) {
    if (line.length >= 5 && line.subarray(0, 5).equals(Buffer.from('=yend'))) {
      trailer = fields(line.toString('latin1'))
      break
    }
    for (let i = 0; i < line.length; i++) {
      let byte = line[i]
      if (byte === ESCAPE) {
        // An escape as a line's last byte escapes nothing: posters' encoders shouldn't, but some do.
        if (++i >= line.length) break
        byte = line[i] - 64
      }
      if (length >= data.length) throw new YencError('This article holds more data than it says')
      data[length++] = (byte - 42) & 0xff
    }
  }
  if (!trailer) throw new YencError('This article ends before its yEnc trailer')
  if (
    length !== expected ||
    (trailer.has('size') && count(trailer.get('size'), 'size') !== length)
  ) {
    throw new YencError('This article’s data is shorter or longer than it says')
  }
  const decoded = data.subarray(0, length)
  const expectedCrc = checksum(begin.has('part') ? trailer.get('pcrc32') : trailer.get('crc32'))
  if (expectedCrc !== undefined && crc32(decoded) >>> 0 !== expectedCrc >>> 0) {
    throw new YencError('This article’s data doesn’t match its checksum')
  }
  return { name, fileSize, offset, data: decoded }
}
