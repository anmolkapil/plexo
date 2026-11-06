import { createHash } from 'node:crypto'

// HLS playlist parsing and resolution, ported from awesome-downloader's core/hls.mjs. Pure apart
// from the injected `fetchText`, so every rule can be checked against exact playlists. Only
// on-demand, unencrypted playlists are supported; anything else is refused with a clear message
// rather than producing a broken file.

export const MAX_HLS_SEGMENTS = 20_000
export const MAX_HLS_NESTING = 3

export interface HlsVariant {
  url: string
  bandwidth: number
  resolution: string | null
  audioGroup?: string
  audioUrl?: string
}

export type HlsPlaylist =
  | { kind: 'master'; variants: HlsVariant[] }
  | { kind: 'media'; urls: string[]; durationSeconds: number; extension: '.mp4' | '.ts' }

export interface ResolvedHls {
  /** Initialization map (if any) followed by every segment, in order. */
  urls: string[]
  durationSeconds: number
  extension: '.mp4' | '.ts'
  /** A hash of the segment list: changes if the server re-issues different segments. */
  identity: string
  /** The separate audio rendition of the chosen variant, if it has one. */
  audio?: ResolvedHls
}

export type FetchText = (
  url: string,
  headers: Record<string, string>
) => Promise<{ text: string; url: string }>

export function httpUrl(value: string): string {
  if (value.length > 16_384) throw new Error('Invalid download URL.')
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only HTTP and HTTPS downloads are supported.')
  if (url.username || url.password)
    throw new Error('Use request headers for authentication, not credentials in URLs.')
  return url.href
}

/** Credentials meant for one site must not follow a playlist to another. */
export function scopedHeaders(
  headers: Record<string, string>,
  source: string,
  target: string
): Record<string, string> {
  const next = { ...headers }
  if (new URL(source).origin !== new URL(target).origin) {
    delete next.cookie
    delete next.authorization
    delete next.origin
  }
  return next
}

function attributes(line: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    fields[match[1]] = match[2].replace(/^"|"$/g, '')
  }
  return fields
}

export function parseHls(text: string, base: string): HlsPlaylist {
  if (!text.trimStart().startsWith('#EXTM3U'))
    throw new Error('The server did not return an HLS playlist.')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const variants: HlsVariant[] = []
  const segments: string[] = []
  const audio = new Map<string, string>()
  let pending: Record<string, string> | null = null
  let durationSeconds = 0
  let map: string | null = null
  let encrypted = false

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line)
      if (
        a.TYPE === 'AUDIO' &&
        a.URI &&
        a['GROUP-ID'] &&
        (!audio.has(a['GROUP-ID']) || a.DEFAULT === 'YES')
      ) {
        audio.set(a['GROUP-ID'], httpUrl(new URL(a.URI, base).href))
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = attributes(line)
    } else if (line.startsWith('#EXT-X-KEY:')) {
      if (attributes(line).METHOD !== 'NONE') encrypted = true
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      throw new Error('HLS byte-range playlists are not supported yet.')
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attributes(line)
      if (a.BYTERANGE) throw new Error('HLS byte-range initialization is not supported yet.')
      const next = httpUrl(new URL(a.URI, base).href)
      if (map && map !== next)
        throw new Error('HLS streams with changing initialization maps are not supported yet.')
      map = next
    } else if (line.startsWith('#EXTINF:')) {
      durationSeconds += Number.parseFloat(line.slice(8)) || 0
    } else if (!line.startsWith('#')) {
      const url = httpUrl(new URL(line, base).href)
      if (pending) {
        variants.push({
          url,
          bandwidth: Number(pending.BANDWIDTH) || 0,
          resolution: pending.RESOLUTION || null,
          audioGroup: pending.AUDIO
        })
        pending = null
      } else {
        segments.push(url)
      }
    }
  }

  if (encrypted) throw new Error('Encrypted HLS is not supported.')
  if (variants.length) {
    return {
      kind: 'master',
      variants: variants
        .map((v) => ({ ...v, audioUrl: v.audioGroup ? audio.get(v.audioGroup) : undefined }))
        .sort((a, b) => b.bandwidth - a.bandwidth)
    }
  }
  if (!lines.includes('#EXT-X-ENDLIST'))
    throw new Error('Live HLS streams are not supported yet. Choose an on-demand video.')
  if (!segments.length || segments.length > MAX_HLS_SEGMENTS)
    throw new Error(
      `HLS playlist has no segments or exceeds the ${MAX_HLS_SEGMENTS.toLocaleString('en-US')} segment limit.`
    )
  return {
    kind: 'media',
    urls: map ? [map, ...segments] : segments,
    durationSeconds,
    extension: map ? '.mp4' : '.ts'
  }
}

/** Follows a master playlist to its best variant (and that variant's audio rendition) and returns
 * the flat list of URLs to download. */
export async function resolveHls(
  url: string,
  headers: Record<string, string>,
  fetchText: FetchText,
  depth = 0,
  source = url
): Promise<ResolvedHls> {
  if (depth > MAX_HLS_NESTING) throw new Error('Too many nested HLS playlists.')
  const playlist = await fetchText(url, scopedHeaders(headers, source, url))
  const parsed = parseHls(playlist.text, playlist.url)
  if (parsed.kind === 'master') {
    const chosen = parsed.variants[0]
    const video = await resolveHls(chosen.url, headers, fetchText, depth + 1, source)
    if (chosen.audioUrl) {
      video.audio = await resolveHls(chosen.audioUrl, headers, fetchText, depth + 1, source)
    }
    return video
  }
  return {
    urls: parsed.urls,
    durationSeconds: parsed.durationSeconds,
    extension: parsed.extension,
    identity: createHash('sha256').update(JSON.stringify(parsed.urls)).digest('hex')
  }
}
