import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { NzbProbeResult, NzbSegmentState } from '../../../shared/types'
import { STRIPPED_FROM_NAMES } from '../torrent/paths'

/** An NZB is a list of message IDs; a few MB for even a large release. A file or link much
 * larger than this isn't one. */
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

function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    found.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3]))
  }
  return found
}

/** Every `<tag …>…</tag>` in `xml`, prefixed or not: its attributes and what's inside. */
function* elements(
  xml: string,
  tag: string
): Generator<{ attrs: Map<string, string>; body: string }> {
  // An attribute's quoted value may hold a `>`: XML allows it unescaped, and subjects do.
  const pattern = new RegExp(
    `<(?:[\\w-]+:)?${tag}\\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>)`,
    'gi'
  )
  for (const match of xml.matchAll(pattern)) {
    yield { attrs: attributes(match[1]), body: match[2] ?? '' }
  }
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
  return subject
    .replace(/\s*yEnc\b.*$/i, '')
    .replace(/\s*\(\d+\/\d+\)\s*$/, '')
    .trim()
}

/**
 * A name that can be saved as is, inside the download's folder, on any of the systems Plexo runs
 * on: nothing that names another folder, no character Windows refuses, no name it reserves, and
 * no longer than a file system allows (the extension kept).
 */
export function safeName(raw: string, fallback: string): string {
  let name = raw.replace(STRIPPED_FROM_NAMES, '_').replace(/[\u007f]/g, '_')
  name = name.replace(/[. ]+$/, '').trim()
  if (!name || name === '.' || name === '..') name = fallback
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    const characters = Array.from(name.slice(0, name.length - extension.length))
    while (Buffer.byteLength(characters.join('') + extension) > MAX_NAME_BYTES) characters.pop()
    name = characters.join('') + extension
  }
  return name
}

/** "Name (2).ext": a second file of the same name. Compared without case, as macOS and Windows
 * compare names. */
function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>()
  return names.map((name) => {
    let candidate = name
    for (let index = 2; taken.has(candidate.toLowerCase()); index++) {
      const dot = name.lastIndexOf('.')
      candidate =
        dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`
    }
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
  const xml = Buffer.from(source)
    .toString('utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
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
  const error = /<error\b([^>]*)\/?>/i.exec(xml)
  if (!error || /<(?:[\w-]+:)?nzb\b/i.test(xml)) return null
  const attrs = attributes(error[1])
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
