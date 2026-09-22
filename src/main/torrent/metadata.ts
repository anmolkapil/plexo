import type { MagnetLink } from './magnet'
import { METADATA_PIECE_BYTES, PeerConnection } from './peerConnection'
import { InterfaceHealth } from './interfaceHealth'
import {
  UNKNOWN_REMAINING_BYTES,
  announceToAll,
  generatePeerId,
  type PeerAddress
} from './trackerClient'
import { parseInfoDict, type TorrentInfo } from './torrentInfo'

export interface MetadataSourceInterface {
  id: string
  /** Local IP to source peer connections from. */
  address: string
}

export interface ResolveMetadataOptions {
  magnet: MagnetLink
  interfaces: MetadataSourceInterface[]
  signal: AbortSignal
}

export interface ResolvedMetadata {
  info: TorrentInfo
  /** The raw bencoded info dict, kept so a download can persist it and resume later without
   * having to find a peer willing to serve its metadata all over again. */
  raw: Buffer
}

/**
 * Open trackers announced to alongside whatever the magnet names.
 *
 * Supplementary rather than a fallback, which is a deliberate change of mind: measured
 * against a real Ubuntu magnet, the tracker the link named returned exactly 1 peer while
 * these four returned 126 between them. A single-tracker magnet is the common case, and one
 * tracker having a thin view of the swarm is not an error state — it is normal. Relying only
 * on the named tracker leaves a healthy torrent looking dead.
 *
 * They also cover trackerless magnets, which would otherwise need the DHT that Plexo does
 * not speak yet.
 */
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce'
]

// Metadata is small and any one peer can serve all of it, so this is about how many chances
// we take at once. Pitched high because a tracker's peer list is mostly stale: of 20 peers
// dialed against a live Ubuntu swarm, none answered — the working ones are found by getting
// through the list quickly, not by waiting longer on each.
const PARALLEL_METADATA_PEERS = 24

const RESOLVE_TIMEOUT_MS = 45_000

/** Matches the cap in `parseInfoDict`, checked here too so a hostile `metadata_size` can't
 * make us allocate against it before a single byte has arrived. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024

interface MetadataAttempt {
  buffer: Buffer
  receivedPieces: boolean[]
  remainingPieces: number
}

/** The magnet's own trackers first, then the open ones it didn't name, de-duplicated. */
export function trackersFor(magnet: MagnetLink): string[] {
  return [...new Set([...magnet.trackers, ...DEFAULT_TRACKERS])]
}

/**
 * Announces to every tracker and returns the pooled peer list.
 *
 * `remainingBytes` must not be zero: a tracker reads that as "this peer is a seed" and
 * replies with only the leechers it knows, holding back the seeds. Before metadata arrives
 * the true figure is unknowable, so the magnet's advertised length stands in where it has
 * one and a non-zero placeholder does otherwise.
 */
export async function discoverPeers(
  magnet: MagnetLink,
  peerId: Buffer,
  signal: AbortSignal,
  remainingBytes?: number
): Promise<PeerAddress[]> {
  const left = remainingBytes ?? magnet.exactLength ?? UNKNOWN_REMAINING_BYTES
  return announceToAll(trackersFor(magnet), {
    infoHash: magnet.infoHash,
    peerId,
    left: left > 0 ? left : UNKNOWN_REMAINING_BYTES,
    signal
  })
}

/**
 * Turns a magnet link into the torrent metadata a download needs, by asking peers for it
 * over BEP 9.
 *
 * A magnet link carries only an infohash, so until this succeeds there is no file name, no
 * size and no piece list — nothing to show the user and nothing to download. Peers are
 * dialed in parallel across the given interfaces because most of them will not answer:
 * they are stale tracker entries, firewalled, or simply not interested in us.
 *
 * `parseInfoDict` re-derives the infohash from whatever arrives, so a peer cannot substitute
 * different metadata; a peer that tries is dropped and the next one is tried instead.
 */
export async function resolveTorrentMetadata(
  options: ResolveMetadataOptions
): Promise<ResolvedMetadata> {
  const { magnet, interfaces, signal } = options
  if (interfaces.length === 0) throw new Error('Select at least one network interface')

  const peerId = generatePeerId()
  const peers = await discoverPeers(magnet, peerId, signal)
  if (peers.length === 0) {
    throw new Error('No peers are available for this magnet link right now')
  }

  return new Promise<ResolvedMetadata>((resolve, reject) => {
    const queue = [...peers]
    const active = new Set<PeerConnection>()
    const attempts = new Map<PeerConnection, MetadataAttempt>()
    const health = new InterfaceHealth(interfaces)
    let settled = false
    let dialed = 0

    // Bounds the peers handed back after an unroutable dial, so a machine where every
    // network turns out to be unreachable stops instead of recycling the same list.
    let requeuesLeft = peers.length

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      for (const connection of active) {
        connection.onClose = undefined
        connection.destroy()
      }
      active.clear()
      attempts.clear()
      fn()
    }

    const succeed = (resolved: ResolvedMetadata): void => finish(() => resolve(resolved))
    const fail = (error: Error): void => finish(() => reject(error))

    const onAbort = (): void => fail(new Error('Metadata lookup aborted'))
    const timer = setTimeout(
      () =>
        fail(
          new Error(
            `Could not fetch torrent metadata from any of ${dialed} peers — the swarm may be dead or unreachable`
          )
        ),
      RESOLVE_TIMEOUT_MS
    )

    if (signal.aborted) {
      fail(new Error('Metadata lookup aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const dialNext = (): void => {
      if (settled) return

      while (active.size < PARALLEL_METADATA_PEERS && queue.length > 0) {
        const peer = queue.shift()
        if (!peer) break

        // Rotates only over networks that have actually reached a peer. Without this, a
        // machine with a few virtual adapters spends most of the swarm on dials that fail
        // instantly with ENETUNREACH.
        const iface = health.next()
        if (!iface) break
        dialed += 1

        const connection = new PeerConnection({
          peer,
          localAddress: iface.address,
          interfaceId: iface.id,
          infoHash: magnet.infoHash,
          peerId
        })

        // Reaching a peer's handshake at all clears this network's earlier failures — they
        // were the peers' fault, not the route's.
        connection.onHavePiece = () => health.noteSuccess(iface.id)

        connection.onMetadataSize = (totalBytes) => {
          health.noteSuccess(iface.id)
          if (attempts.has(connection)) return // already sizing/fetching from this peer
          if (totalBytes <= 0 || totalBytes > MAX_METADATA_BYTES) {
            connection.destroy()
            return
          }

          const pieceCount = Math.ceil(totalBytes / METADATA_PIECE_BYTES)
          attempts.set(connection, {
            buffer: Buffer.alloc(totalBytes),
            receivedPieces: new Array<boolean>(pieceCount).fill(false),
            remainingPieces: pieceCount
          })

          // Metadata runs to a few hundred KB at most, so there is nothing to gain from
          // pacing these the way piece requests are paced.
          for (let index = 0; index < pieceCount; index += 1) {
            connection.requestMetadataPiece(index)
          }
        }

        connection.onMetadataPiece = (index, data) => {
          const attempt = attempts.get(connection)
          if (!attempt) return
          if (index < 0 || index >= attempt.receivedPieces.length) return
          if (attempt.receivedPieces[index]) return

          const offset = index * METADATA_PIECE_BYTES
          const expected = Math.min(METADATA_PIECE_BYTES, attempt.buffer.length - offset)
          if (data.length !== expected) {
            // Wrong-sized piece means we'd assemble a blob that can't hash correctly.
            connection.destroy()
            return
          }

          data.copy(attempt.buffer, offset)
          attempt.receivedPieces[index] = true
          attempt.remainingPieces -= 1
          if (attempt.remainingPieces > 0) return

          try {
            succeed({ info: parseInfoDict(attempt.buffer, magnet.infoHash), raw: attempt.buffer })
          } catch {
            // This peer served metadata that isn't this torrent's. Drop it and let another
            // peer try rather than failing the whole lookup on one bad actor.
            attempts.delete(connection)
            connection.destroy()
          }
        }

        connection.onClose = (error) => {
          active.delete(connection)
          attempts.delete(connection)

          // A dial that failed because this network has no route to the internet says
          // nothing about the peer, so hand it back for a network that does have one.
          if (health.noteFailure(iface.id, error) && requeuesLeft > 0) {
            requeuesLeft -= 1
            queue.unshift(peer)
          }

          if (active.size === 0 && queue.length === 0) {
            fail(
              new Error(
                `None of the ${dialed} peers found for this magnet link could supply its metadata`
              )
            )
            return
          }
          dialNext()
        }

        active.add(connection)
        connection.connect()
      }
    }

    dialNext()
  })
}
