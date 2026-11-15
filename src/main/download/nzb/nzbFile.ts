import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { NzbProbeResult, NzbSegmentState } from '../../../shared/types'
import { STRIPPED_FROM_NAMES } from '../torrent/paths'

/** An NZB is a list of message IDs; a few MB for even a large release, and 64 MB lists about
 * 500 GB of articles. A file or link much larger than this isn't one. */
const MAX_NZB_FILE_BYTES = 64 * 1024 * 1024
const TOO_LARGE = 'Plexo supports NZB files up to 64 MB.'
const NOT_NZB = 'This isn’t an NZB file Plexo can read'
const MAX_NAME_BYTES = 255
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** One article, as the NZB lists it. */
export interface NzbSegment {
  /** Its place in its file, from 1. */
  number: number
  /** Its size as posted: the encoded article, a little more than the data it holds. */
  bytes: number
  messageId: string
}

export interface NzbFileEntry {
  /** Safe to save in the download's folder on any system (see safeName). */
  name: string
  segments: NzbSegment[]
}

export interface ParsedNzb {
  files: NzbFileEntry[]
  /** The archive password the poster put in the NZB's head, if any. */
  password?: string
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

/** `name="value"` or `name='value'` pairs, by lowercased name. A name that isn't followed by a
 * value is passed over whole: trying it again from each of its characters (as one regex over
 * `source` would) takes time that grows with the square of its length. */
function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  const name = /[\w:-]+/g
  const value = /\s*=\s*(?:"([^"]*)"|'([^']*)')/y
  for (let match = name.exec(source); match; match = name.exec(source)) {
    value.lastIndex = name.lastIndex
    const assigned = value.exec(source)
    if (!assigned) continue
    found.set(match[0].toLowerCase(), decodeEntities(assigned[1] ?? assigned[2]))
    name.lastIndex = value.lastIndex
  }
  return found
}

/**
 * Where a start tag ends, given where its attributes begin: at its first `>` outside quotes (an
 * attribute's quoted value may hold a `>`: XML allows it unescaped, and subjects do), or -1 when
 * a quote is never closed or no `>` follows.
 *
 * One file asks this of every start tag in it, in order, so each answer is kept for the next:
 * past an opening quote, every search goes the same way, so a later one that reaches a quote an
 * earlier one went through takes its answer, rather than reading the rest of the file again.
 */
function startTagEnds(xml: string): (from: number) => number {
  const special = /[>"']/g
  const nextSpecial = (from: number): number => {
    special.lastIndex = from
    return special.exec(xml)?.index ?? -1
  }
  // The first `>` or quote at or after `searchedFrom`. Start tags come in order, so it stays the
  // answer for each one that begins before it.
  let searchedFrom = Infinity
  let found = -1
  const fromQuote = new Map<number, number>()
  return (from) => {
    if (from < searchedFrom || (found !== -1 && from > found)) {
      searchedFrom = from
      found = nextSpecial(from)
    }
    const entered: number[] = []
    let end = -1
    for (let at = found; at !== -1;) {
      if (xml[at] === '>') {
        end = at
        break
      }
      const known = fromQuote.get(at)
      if (known !== undefined) {
        end = known
        break
      }
      entered.push(at)
      const closed = xml.indexOf(xml[at], at + 1)
      at = closed === -1 ? -1 : nextSpecial(closed + 1)
    }
    for (const quote of entered) fromQuote.set(quote, end)
    return end
  }
}

/** Where each `</tag>` (prefixed or not) in `xml` begins and ends, in order. */
function closingTags(xml: string, tag: string): { starts: number[]; ends: number[] } {
  const closing = new RegExp(`</(?:[\\w-]+:)?${tag}\\s*>`, 'iy')
  const starts: number[] = []
  const ends: number[] = []
  for (let at = xml.indexOf('</'); at !== -1; at = xml.indexOf('</', at + 2)) {
    closing.lastIndex = at
    if (closing.test(xml)) {
      starts.push(at)
      ends.push(closing.lastIndex)
    }
  }
  return { starts, ends }
}

/** The index of the first of `sorted` at or past `value`; `sorted.length` when there's none. */
function firstFrom(sorted: number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * Every `<tag …>…</tag>` and `<tag …/>` in `xml`, prefixed or not: its attributes and what's
 * inside, up to the first closing tag after it. One that never ends is passed over, and the next
 * is looked for from just after its `<`.
 *
 * What one regex over the file found, but in time that grows with the file rather than with its
 * square: that regex looked for each element's end from its start, so a file of many unclosed
 * tags had it read the rest of the file again for every one of them.
 */
function* elements(
  xml: string,
  tag: string
): Generator<{ attrs: Map<string, string>; body: string }> {
  const name = new RegExp(`(?:[\\w-]+:)?${tag}\\b`, 'iy')
  const startTagEnd = startTagEnds(xml)
  let closing: ReturnType<typeof closingTags> | undefined
  for (let at = xml.indexOf('<'); at !== -1; at = xml.indexOf('<', at)) {
    name.lastIndex = at + 1
    if (!name.test(xml)) {
      at++
      continue
    }
    const attrsStart = name.lastIndex
    const end = startTagEnd(attrsStart)
    if (end !== -1 && xml[end - 1] === '/') {
      yield { attrs: attributes(xml.slice(attrsStart, end - 1)), body: '' }
      at = end + 1
      continue
    }
    closing ??= closingTags(xml, tag)
    const close = end === -1 ? -1 : firstFrom(closing.starts, end + 1)
    if (close === -1 || close === closing.starts.length) {
      at++
      continue
    }
    yield {
      attrs: attributes(xml.slice(attrsStart, end)),
      body: xml.slice(end + 1, closing.starts[close])
    }
    at = closing.ends[close]
  }
}

/** `text` with each `open … close` span (the first `close` after it) put through `replace`. One
 * left open is left as it is, and so is everything after it: no `close` follows. */
function replaceSpans(
  text: string,
  open: string,
  close: string,
  replace: (inside: string) => string
): string {
  const parts: string[] = []
  let at = 0
  for (let start = text.indexOf(open); start !== -1; start = text.indexOf(open, at)) {
    const end = text.indexOf(close, start + open.length)
    if (end === -1) break
    parts.push(text.slice(at, start), replace(text.slice(start + open.length, end)))
    at = end + close.length
  }
  parts.push(text.slice(at))
  return parts.join('')
}

/** Where the run of whitespace (as `\s` matches it) that ends at `end` begins. */
function whitespaceBefore(text: string, end: number): number {
  let start = end
  while (start > 0 && /\s/.test(text[start - 1])) start--
  return start
}

/** `subject` up to its first `yEnc` (any case, followed by no letter, digit or `_`) with no line
 * break after it, less the whitespace before it: what `/\s*yEnc\b.*$/i` would cut off, found
 * without trying that from every character of a long run of spaces. */
function beforeYenc(subject: string): string {
  let from = subject.length
  while (from > 0 && !/[\n\r\u2028\u2029]/.test(subject[from - 1])) from--
  const yenc = /yEnc/gi
  yenc.lastIndex = from
  for (let match = yenc.exec(subject); match; match = yenc.exec(subject)) {
    if (!/\w/.test(subject[match.index + 4] ?? '')) {
      return subject.slice(0, whitespaceBefore(subject, match.index))
    }
  }
  return subject
}

/** `subject` less an article count at its end, `(1/50)`, and the whitespace around it: what
 * `/\s*\(\d+\/\d+\)\s*$/` would cut off. */
function beforeArticleCount(subject: string): string {
  const trimmed = subject.trimEnd()
  const count = /\(\d+\/\d+\)$/.exec(trimmed)
  return count ? subject.slice(0, whitespaceBefore(trimmed, count.index)) : subject
}

/** A file's name from its subject. Posters quote it — `[01/20] - "Name.part01.rar" yEnc (1/50)` —
 * and the rest is a guess at what's left once the article count is taken off. */
export function nameFromSubject(subject: string): string {
  const quoted = /"([^"]+)"/.exec(subject)
  if (quoted) return quoted[1].trim()
  const withExtension = /(?:^|\s)([^\s"]+\.[a-z0-9]{2,5})(?:\s+yEnc\b|\s*\(\d+\/\d+\)|$)/i.exec(
    subject
  )
  if (withExtension) return withExtension[1]
  return beforeArticleCount(beforeYenc(subject)).trim()
}

/**
 * A name that can be saved as is, inside the download's folder, on any of the systems Plexo runs
 * on: nothing that names another folder, no character Windows refuses, no name it reserves, and
 * no longer than a file system allows (the extension kept).
 */
export function safeName(raw: string, fallback: string): string {
  let name = raw.replace(STRIPPED_FROM_NAMES, '_').replace(/[\u007f]/g, '_')
  // Trailing dots and spaces, which Windows drops, taken off from the end: `/[. ]+$/` would try
  // every dot and space in the name.
  let end = name.length
  while (end > 0 && (name[end - 1] === '.' || name[end - 1] === ' ')) end--
  name = name.slice(0, end).trim()
  if (!name || name === '.' || name === '..') name = fallback
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    // As many whole characters as fit before the extension.
    let room = MAX_NAME_BYTES - Buffer.byteLength(extension)
    let kept = ''
    for (const character of name.slice(0, name.length - extension.length)) {
      room -= Buffer.byteLength(character)
      if (room < 0) break
      kept += character
    }
    name = kept + extension
  }
  return name
}

/** "Name (2).ext": a second file of the same name. Compared without case, as macOS and Windows
 * compare names. */
function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>()
  // The number to try next for each name: the ones before it are taken, and stay taken. Starting
  // from 2 each time, a thousand files of one name would try half a million names.
  const next = new Map<string, number>()
  return names.map((name) => {
    let candidate = name
    let index = next.get(name.toLowerCase()) ?? 2
    for (; taken.has(candidate.toLowerCase()); index++) {
      const dot = name.lastIndexOf('.')
      candidate =
        dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`
    }
    next.set(name.toLowerCase(), index)
    taken.add(candidate.toLowerCase())
    return candidate
  })
}

/** par2 files last, the small index file first among them: what is fetched first is what the
 * user can start on. Otherwise by name, numbers in order ("part2" before "part10"). */
function downloadOrder(a: NzbFileEntry, b: NzbFileEntry): number {
  const rank = (file: NzbFileEntry): number =>
    !/\.par2$/i.test(file.name) ? 0 : /\.vol\d+\+\d+\.par2$/i.test(file.name) ? 2 : 1
  return (
    rank(a) - rank(b) ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  )
}

/** Reads an NZB. Throws when it isn't one, or lists nothing to download. */
export function parseNzb(source: Uint8Array): ParsedNzb {
  const text = Buffer.from(source).toString('utf8')
  const xml = replaceSpans(
    replaceSpans(text, '<!--', '-->', () => ''),
    '<![CDATA[',
    ']]>',
    (data) => data.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  )
  if (!/<(?:[\w-]+:)?nzb\b/i.test(xml)) throw new Error(NOT_NZB)

  let password: string | undefined
  for (const meta of elements(xml, 'meta')) {
    if (meta.attrs.get('type')?.toLowerCase() === 'password') {
      password = decodeEntities(meta.body).trim() || undefined
    }
  }

  const raw: { name: string; segments: NzbSegment[] }[] = []
  let index = 0
  for (const file of elements(xml, 'file')) {
    index++
    const seen = new Set<number>()
    const segments: NzbSegment[] = []
    for (const segment of elements(file.body, 'segment')) {
      const number = Number(segment.attrs.get('number'))
      const bytes = Number(segment.attrs.get('bytes'))
      const messageId = decodeEntities(segment.body).trim().replace(/^<|>$/g, '')
      // A message ID can't hold whitespace or angle brackets: one that does would break the command.
      if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) continue
      if (!messageId || /[\s<>]/.test(messageId)) continue
      seen.add(number)
      segments.push({
        number,
        // Every article is at least one byte; a missing or bad size counts as that.
        bytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 1,
        messageId
      })
    }
    if (segments.length === 0) continue
    segments.sort((a, b) => a.number - b.number)
    raw.push({
      name: safeName(nameFromSubject(file.attrs.get('subject') ?? ''), `file-${index}`),
      segments
    })
  }
  if (raw.length === 0) throw new Error('This NZB lists no files to download')
  raw.sort(downloadOrder)
  const names = uniqueNames(raw.map((file) => file.name))
  return { files: raw.map((file, i) => ({ ...file, name: names[i] })), password }
}

/** Its articles as one download's segments, file after file, each as long as the NZB says. */
export function planSegments(nzb: ParsedNzb): NzbSegmentState[] {
  const segments: NzbSegmentState[] = []
  let rangeStart = 0
  for (const file of nzb.files) {
    for (const segment of file.segments) {
      segments.push({
        kind: 'nzb',
        index: segments.length,
        rangeStart,
        rangeEnd: rangeStart + segment.bytes - 1,
        status: 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {}
      })
      rangeStart += segment.bytes
    }
  }
  return segments
}

/** For each segment, by index: its file's index and the article. */
export function segmentArticles(nzb: ParsedNzb): { file: number; segment: NzbSegment }[] {
  return nzb.files.flatMap((file, index) =>
    file.segments.map((segment) => ({ file: index, segment }))
  )
}

/** The NZB of each one probed lately, by hash: what a download of it starts from, so the window
 * never has to hold or send it. */
const recent = new Map<string, Uint8Array>()
const RECENT_LIMIT = 8

export function probedNzbFile(hash: string): Uint8Array | undefined {
  return recent.get(hash)
}

/** What an NZB holds, as a probe result. `name`: what to call the download, when the link or
 * file has a name of its own. */
export function describeNzb(nzbFile: Uint8Array, link: string, name: string): NzbProbeResult {
  const nzb = parseNzb(nzbFile)
  const hash = createHash('sha256').update(nzbFile).digest('hex').slice(0, 32)
  recent.delete(hash)
  recent.set(hash, nzbFile)
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!)
  const files = nzb.files.map((file) => ({
    name: file.name,
    bytes: file.segments.reduce((sum, segment) => sum + segment.bytes, 0),
    segments: file.segments.length
  }))
  return {
    kind: 'nzb',
    requestedUrl: link,
    finalUrl: link,
    supportsRanges: true,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    suggestedFileName: safeName(name.replace(/\.nzb$/i, ''), 'Usenet download'),
    contentType: 'application/x-nzb',
    etag: null,
    lastModified: null,
    nzb: { hash, files }
  }
}

/** An NZB file on this computer. */
export async function readNzbFile(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > MAX_NZB_FILE_BYTES) throw new Error(TOO_LARGE)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** How much of an XML answer is read to tell an NZB from an indexer's error. */
const SNIFF_BYTES = 64 * 1024

/** The start of what `url` answers, as text: enough to see what kind of XML it is. */
export async function sniffXml(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<string> {
  const stop = new AbortController()
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)])
  })
  if (!response.ok || !response.body) {
    throw new Error(`Server responded with status ${response.status}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for await (const chunk of response.body) {
      chunks.push(chunk)
      total += chunk.length
      if (total >= SNIFF_BYTES) break
    }
  } finally {
    stop.abort()
  }
  return Buffer.concat(chunks).subarray(0, SNIFF_BYTES).toString('utf8')
}

/** An indexer's refusal, as its (Newznab) API sends one in place of the NZB:
 * `<error code="100" description="Incorrect user credentials"/>`. Null when it isn't one. */
export function indexerError(xml: string): string | null {
  // The first `<error` and its first `>`: if that one has none, no later one does. (A regex
  // looking for both tried every `<error` against the rest of the answer.)
  const error = /<error\b/i.exec(xml)
  const end = error ? xml.indexOf('>', error.index + '<error'.length) : -1
  if (!error || end === -1 || /<(?:[\w-]+:)?nzb\b/i.test(xml)) return null
  const attrs = attributes(xml.slice(error.index + '<error'.length, end))
  const description = attrs.get('description')?.trim()
  const code = attrs.get('code')?.trim()
  return `The indexer refused this link: ${description || 'no reason given'}${code ? ` (error ${code})` : ''}`
}

/** An NZB file a link points at, as an indexer serves it. `headers` are for `url`. */
export async function downloadNzbFile(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<Uint8Array> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok || !response.body) {
    throw new Error(`Server responded with status ${response.status}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > MAX_NZB_FILE_BYTES) throw new Error(TOO_LARGE)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
