import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { ProbeResult } from '../../../shared/types'
import { testKnobs } from '../../testKnobs'
import { createClient } from './engine'
import { safeTorrentPaths } from './paths'

/** A .torrent file is metadata only; a link answering with more than this isn't one. */
const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
const TOO_LARGE = 'Plexo supports .torrent files up to 10 MB.'
const V2_ONLY = 'This torrent uses BitTorrent v2 only, which Plexo doesn’t support yet'
const NO_PEERS = 'No peers responded to this magnet link. Try again later or open a .torrent file.'

/** The .torrent of each torrent probed lately, by info hash: what a download of it starts from,
 * so the window never has to hold or send it. */
const recent = new Map<string, Uint8Array>()
const RECENT_LIMIT = 8

export function probedTorrentFile(infoHash: string): Uint8Array | undefined {
  return recent.get(infoHash)
}

function remember(infoHash: string, torrentFile: Uint8Array): void {
  recent.delete(infoHash)
  recent.set(infoHash, torrentFile)
  if (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!)
}

/** What a .torrent holds, as a probe result — once its paths are known to be safe to write. */
export async function describeTorrent(torrentFile: Uint8Array, link: string): Promise<ProbeResult> {
  const { default: parseTorrent } = await import('parse-torrent')
  const parsed = await parseTorrent(torrentFile).catch((error: unknown) => {
    // parse-torrent's check for the v1 piece hashes, which a v2-only torrent doesn't have.
    if (error instanceof Error && error.message.endsWith('info.pieces')) throw new Error(V2_ONLY)
    throw new Error('This isn’t a torrent Plexo can read')
  })
  const files = safeTorrentPaths(parsed.files ?? [])
  remember(parsed.infoHash, torrentFile)
  return {
    kind: 'torrent',
    requestedUrl: link,
    finalUrl: link,
    supportsRanges: true,
    totalBytes: parsed.length ?? 0,
    suggestedFileName: parsed.name ?? parsed.infoHash,
    contentType: 'application/x-bittorrent',
    etag: null,
    lastModified: null,
    torrent: { infoHash: parsed.infoHash, pieceLength: parsed.pieceLength ?? 0, files }
  }
}

/** A .torrent file on this computer. */
export async function readTorrentFile(path: string): Promise<Uint8Array> {
  const handle = await open(path, 'r')
  try {
    if ((await handle.stat()).size > MAX_TORRENT_FILE_BYTES) throw new Error(TOO_LARGE)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** A .torrent file a link points at. */
export async function downloadTorrentFile(url: string, timeoutMs: number): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Plexo/1.0' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok || !response.body) {
    throw new Error(`Server responded with status ${response.status}`)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body) {
    total += chunk.length
    if (total > MAX_TORRENT_FILE_BYTES) throw new Error(TOO_LARGE)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Fetches magnet links' metadata from their peers, over the default route: only a download's
 * own client pins peers to networks. Kept for the app's life, so its DHT stays warm. */
let probeClient: Promise<WebTorrent> | null = null
/** The magnet link being looked up. A newer one replaces it: the window only shows the latest. */
let current: { infoHash: string; metadata: Promise<Uint8Array>; cancel: () => void } | null = null

/** A magnet link's .torrent, from whichever of its peers answers first. */
export async function fetchMagnetMetadata(magnet: string): Promise<Uint8Array> {
  const { default: parseTorrent } = await import('parse-torrent')
  const { infoHash } = await parseTorrent(magnet).catch(() => {
    throw new Error('This magnet link isn’t valid')
  })
  if (current?.infoHash === infoHash) return current.metadata
  current?.cancel()

  probeClient ??= createClient()
  const client = await probeClient
  const lookup = { infoHash } as NonNullable<typeof current>
  // Set first: a lookup that ends at once must still be able to clear itself.
  current = lookup
  lookup.metadata = new Promise<Uint8Array>((resolve, reject) => {
    // Deselected: only the metadata is wanted, none of the files.
    const torrent = client.add(magnet, { path: join(tmpdir(), 'plexo-magnet'), deselect: true })
    let done = false
    const finish = (error: Error | null, torrentFile?: Uint8Array): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (current === lookup) current = null
      torrent.destroy({ destroyStore: true })
      if (error) reject(error)
      else resolve(torrentFile!)
    }
    const timer = setTimeout(() => finish(new Error(NO_PEERS)), testKnobs.magnetTimeoutMs)
    torrent.once('metadata', () => finish(null, torrent.torrentFile))
    torrent.once('error', (error: Error) => finish(error))
    lookup.cancel = () => finish(new Error('Replaced by a newer link'))
  })
  return lookup.metadata
}
