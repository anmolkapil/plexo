import { randomBytes } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'
import { decode, dictBytes, dictNumber, isDict, type BencodeDict } from './bencode'

export interface PeerAddress {
  host: string
  port: number
}

export interface AnnounceOptions {
  trackerUrl: string
  infoHash: Buffer
  peerId: Buffer
  /**
   * Bytes still needed.
   *
   * This is not cosmetic. A tracker reads `left: 0` as "this peer is a seed" and answers
   * with only the leechers it knows about — deliberately withholding the seeds, since a
   * seed has nothing to download from them. A client that still needs data must therefore
   * never announce 0, which matters most before metadata arrives and the real figure isn't
   * known yet (see UNKNOWN_REMAINING_BYTES).
   */
  left: number
  signal: AbortSignal
}

/**
 * Stand-in for `left` while the true remaining size is still unknown — that is, for every
 * announce made before a magnet's metadata has been fetched. Any non-zero value marks us as
 * a leecher; this one is a plausible magnitude rather than a suspicious sentinel.
 */
export const UNKNOWN_REMAINING_BYTES = 16 * 1024

const ANNOUNCE_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 256 * 1024
const PEERS_WANTED = 80

// Plexo only ever dials out — it never listens for incoming peers — so there is no real
// port to advertise. Trackers require the field and some reject 0, so this is a plausible
// stand-in rather than a socket we actually hold open.
const ADVERTISED_PORT = 6881

const COMPACT_PEER_BYTES = 6

/** Percent-encodes raw bytes per RFC 3986. `URLSearchParams` would UTF-8 encode them first,
 * which mangles the two binary query parameters an announce needs (`info_hash`, `peer_id`). */
function percentEncodeBytes(bytes: Buffer): string {
  let encoded = ''
  for (const byte of bytes) {
    const isUnreserved =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e
    encoded += isUnreserved ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0')}`
  }
  return encoded
}

/** Reads a compact peer list: 4 bytes of IPv4 then a big-endian port, repeated. */
function parseCompactPeers(peers: Buffer): PeerAddress[] {
  const addresses: PeerAddress[] = []
  for (let offset = 0; offset + COMPACT_PEER_BYTES <= peers.length; offset += COMPACT_PEER_BYTES) {
    const port = peers.readUInt16BE(offset + 4)
    if (port === 0) continue
    addresses.push({
      host: `${peers[offset]}.${peers[offset + 1]}.${peers[offset + 2]}.${peers[offset + 3]}`,
      port
    })
  }
  return addresses
}

/** Reads the older dictionary-model peer list, which some trackers still return. */
function parseDictionaryPeers(entries: unknown[]): PeerAddress[] {
  const addresses: PeerAddress[] = []
  for (const entry of entries) {
    if (!isDict(entry as BencodeDict)) continue
    const host = dictBytes(entry as BencodeDict, 'ip')?.toString('utf-8')
    const port = dictNumber(entry as BencodeDict, 'port')
    if (host && port !== null && port > 0) addresses.push({ host, port })
  }
  return addresses
}

function parseAnnounceResponse(body: Buffer): PeerAddress[] {
  const response = decode(body)
  if (!isDict(response)) throw new Error('Tracker response is not a dictionary')

  const failure = dictBytes(response, 'failure reason')
  if (failure) throw new Error(`Tracker refused the announce: ${failure.toString('utf-8')}`)

  const peers = response['peers']
  if (Buffer.isBuffer(peers)) return parseCompactPeers(peers)
  if (Array.isArray(peers)) return parseDictionaryPeers(peers)
  return []
}

function announceHttp(options: AnnounceOptions): Promise<PeerAddress[]> {
  const { trackerUrl, infoHash, peerId, left, signal } = options

  return new Promise((resolve, reject) => {
    const url = new URL(trackerUrl)
    const query = [
      `info_hash=${percentEncodeBytes(infoHash)}`,
      `peer_id=${percentEncodeBytes(peerId)}`,
      `port=${ADVERTISED_PORT}`,
      'uploaded=0',
      'downloaded=0',
      `left=${left}`,
      'compact=1',
      'event=started',
      `numwant=${PEERS_WANTED}`
    ].join('&')

    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
    const request = requester(
      {
        method: 'GET',
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search ? `${url.search}&` : '?'}${query}`,
        signal,
        timeout: ANNOUNCE_TIMEOUT_MS
      },
      (response) => {
        if ((response.statusCode ?? 0) >= 400) {
          response.destroy()
          reject(new Error(`Tracker responded with status ${response.statusCode}`))
          return
        }

        const parts: Buffer[] = []
        let received = 0

        response.on('data', (part: Buffer) => {
          received += part.length
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Tracker response is too large'))
            return
          }
          parts.push(part)
        })
        response.on('end', () => {
          try {
            resolve(parseAnnounceResponse(Buffer.concat(parts)))
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
        response.on('error', reject)
      }
    )

    request.on('timeout', () => request.destroy(new Error('Tracker announce timed out')))
    request.on('error', reject)
    request.end()
  })
}

// BEP 15 (UDP tracker protocol). Most trackers in a magnet link are udp://, so this isn't
// an optional extra — without it a typical link finds no peers at all.
const UDP_PROTOCOL_ID = 0x41727101980n
const UDP_ACTION_CONNECT = 0
const UDP_ACTION_ANNOUNCE = 1
const UDP_ACTION_ERROR = 3
const UDP_CONNECT_RESPONSE_BYTES = 16
const UDP_ANNOUNCE_HEADER_BYTES = 20

function announceUdp(options: AnnounceOptions): Promise<PeerAddress[]> {
  const { trackerUrl, infoHash, peerId, left, signal } = options

  return new Promise((resolve, reject) => {
    const url = new URL(trackerUrl)
    const port = Number(url.port)
    if (!port) {
      reject(new Error(`UDP tracker ${trackerUrl} has no port`))
      return
    }

    const socket = createSocket('udp4')
    const transactionId = randomBytes(4)
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      socket.removeAllListeners()
      // Closing an unbound socket throws, and this is a normal path when send() fails
      // before the socket ever came up.
      try {
        socket.close()
      } catch {
        // Already closed or never bound — nothing to release.
      }
      fn()
    }

    const fail = (error: Error): void => finish(() => reject(error))
    const onAbort = (): void => fail(new Error('Announce aborted'))
    const timer = setTimeout(
      () => fail(new Error('Tracker announce timed out')),
      ANNOUNCE_TIMEOUT_MS
    )

    if (signal.aborted) {
      fail(new Error('Announce aborted'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const connectRequest = Buffer.alloc(16)
    connectRequest.writeBigUInt64BE(UDP_PROTOCOL_ID, 0)
    connectRequest.writeUInt32BE(UDP_ACTION_CONNECT, 8)
    transactionId.copy(connectRequest, 12)

    socket.on('error', fail)

    socket.on('message', (message: Buffer) => {
      if (message.length < 8) return
      // A late reply to a previous exchange would otherwise be read as an answer to this one.
      if (!message.subarray(4, 8).equals(transactionId)) return

      const action = message.readUInt32BE(0)

      if (action === UDP_ACTION_ERROR) {
        fail(new Error(`Tracker error: ${message.subarray(8).toString('utf-8')}`))
        return
      }

      if (action === UDP_ACTION_CONNECT) {
        if (message.length < UDP_CONNECT_RESPONSE_BYTES) {
          fail(new Error('Tracker sent a truncated connect response'))
          return
        }

        const announceRequest = Buffer.alloc(98)
        message.copy(announceRequest, 0, 8, 16) // connection id from the connect response
        announceRequest.writeUInt32BE(UDP_ACTION_ANNOUNCE, 8)
        transactionId.copy(announceRequest, 12)
        infoHash.copy(announceRequest, 16)
        peerId.copy(announceRequest, 36)
        announceRequest.writeBigUInt64BE(0n, 56) // downloaded
        announceRequest.writeBigUInt64BE(BigInt(left), 64)
        announceRequest.writeBigUInt64BE(0n, 72) // uploaded
        announceRequest.writeUInt32BE(2, 80) // event: started
        announceRequest.writeUInt32BE(0, 84) // our IP: let the tracker use the source address
        announceRequest.writeUInt32BE(0, 88) // key
        announceRequest.writeInt32BE(PEERS_WANTED, 92)
        announceRequest.writeUInt16BE(ADVERTISED_PORT, 96)

        socket.send(announceRequest, port, url.hostname, (error) => {
          if (error) fail(error)
        })
        return
      }

      if (action === UDP_ACTION_ANNOUNCE) {
        if (message.length < UDP_ANNOUNCE_HEADER_BYTES) {
          fail(new Error('Tracker sent a truncated announce response'))
          return
        }
        const peers = parseCompactPeers(message.subarray(UDP_ANNOUNCE_HEADER_BYTES))
        finish(() => resolve(peers))
      }
    })

    socket.send(connectRequest, port, url.hostname, (error) => {
      if (error) fail(error)
    })
  })
}

/** Announces to one tracker and returns the peers it knows about. */
export function announce(options: AnnounceOptions): Promise<PeerAddress[]> {
  const separator = options.trackerUrl.indexOf(':')
  const scheme = options.trackerUrl.slice(0, separator).toLowerCase()
  if (scheme === 'udp') return announceUdp(options)
  if (scheme === 'http' || scheme === 'https') return announceHttp(options)
  return Promise.reject(new Error(`Unsupported tracker scheme "${scheme}"`))
}

/**
 * Announces to every tracker at once and pools the peers, de-duplicated.
 *
 * Trackers are unreliable in ordinary operation — dead hosts, rate limits, UDP packets that
 * simply vanish — so one rejection says nothing about the others. The pooled result is only
 * an error when every tracker failed.
 */
export async function announceToAll(
  trackers: string[],
  options: Omit<AnnounceOptions, 'trackerUrl'>
): Promise<PeerAddress[]> {
  const results = await Promise.allSettled(
    trackers.map((trackerUrl) => announce({ ...options, trackerUrl }))
  )

  const byAddress = new Map<string, PeerAddress>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const peer of result.value) {
      byAddress.set(`${peer.host}:${peer.port}`, peer)
    }
  }

  if (byAddress.size === 0 && results.length > 0) {
    const firstRejection = results.find((result) => result.status === 'rejected')
    if (firstRejection?.status === 'rejected' && results.every((r) => r.status === 'rejected')) {
      const reason = firstRejection.reason
      throw new Error(
        `No tracker could be reached${reason instanceof Error ? `: ${reason.message}` : ''}`
      )
    }
  }

  return [...byAddress.values()]
}

/** A random peer id in the widely used Azureus style: a client tag plus 12 random bytes. */
export function generatePeerId(): Buffer {
  return Buffer.concat([Buffer.from('-PX1000-', 'latin1'), randomBytes(12)])
}
