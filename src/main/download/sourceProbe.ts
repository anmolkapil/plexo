import type { NetworkInterfaceInfo, ProbeResult } from '../../shared/types'
import { isMagnetUri, parseMagnetUri } from '../torrent/magnet'
import { resolveTorrentMetadata } from '../torrent/metadata'
import { rememberMetadata, toTorrentMetadata } from '../torrent/metadataStore'
import { probeUrl } from './probe'

/** Metadata lookup dials peers, so it can't outlive a user who has moved on. Generous
 * compared to an HTTP probe because finding a peer that will serve metadata is a swarm
 * operation, not a request to a known server. */
const MAGNET_PROBE_TIMEOUT_MS = 50_000

/**
 * Resolves whatever the user pasted into everything needed to start downloading it.
 *
 * A magnet link's probe is not a formality the way an HTTP probe is: the link carries only
 * an infohash, so the file name, the size and the piece layout all have to be fetched from
 * the swarm before there is anything to show or any way to split the work. That makes this
 * the slow step of a torrent download, and the reason the UI reports it separately.
 */
export async function probeSource(
  rawInput: string,
  interfaces: NetworkInterfaceInfo[]
): Promise<ProbeResult> {
  const input = rawInput.trim()

  if (!isMagnetUri(input)) return probeUrl(input)

  const magnet = parseMagnetUri(input)

  if (interfaces.length === 0) {
    throw new Error('No network connection is available to reach the torrent swarm')
  }

  // Every detected interface is used here, not just the ones selected for the download:
  // this is a lookup, and taking the first peer that answers on any reachable network
  // resolves faster than restricting it to the user's chosen set.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAGNET_PROBE_TIMEOUT_MS)

  try {
    const resolved = await resolveTorrentMetadata({
      magnet,
      interfaces,
      signal: controller.signal
    })
    rememberMetadata(magnet.infoHashHex, resolved)

    return {
      kind: 'torrent',
      requestedUrl: input,
      // The magnet link stays the download's identity: unlike a redirect chain there is no
      // other URL to resolve it to, and it is what a resume has to start from.
      finalUrl: magnet.uri,
      // Pieces are independently fetchable by definition, which is the torrent equivalent
      // of a server supporting range requests — so multi-network splitting always applies.
      supportsRanges: true,
      totalBytes: resolved.info.totalLength,
      suggestedFileName: resolved.info.name,
      contentType: null,
      // Piece hashes already prove every byte, so there is nothing for these to add.
      etag: null,
      lastModified: null,
      torrent: toTorrentMetadata(resolved.info, magnet.infoHashHex)
    }
  } finally {
    clearTimeout(timer)
  }
}
