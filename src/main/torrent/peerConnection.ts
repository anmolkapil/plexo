import { connect, type Socket } from 'node:net'
import { decodePrefix, encode, isDict, dictNumber } from './bencode'
import type { PeerAddress } from './trackerClient'

export interface PeerConnectionOptions {
  peer: PeerAddress
  /** Local IP of the network interface this peer's socket binds to — the reason torrents
   * can aggregate bandwidth the same way Plexo's HTTP downloads do. */
  localAddress: string
  /** Id of that interface, echoed back on every progress report so bytes can be attributed. */
  interfaceId: string
  infoHash: Buffer
  peerId: Buffer
}

const PROTOCOL_NAME = 'BitTorrent protocol'
const HANDSHAKE_BYTES = 68
const INFO_HASH_OFFSET = 28
const RESERVED_OFFSET = 20

// Reserved bit for BEP 10 extension protocol, which is what carries ut_metadata. Without
// it a magnet link has no way to ever learn the torrent's file list.
const RESERVED_EXTENDED_BYTE = 5
const RESERVED_EXTENDED_MASK = 0x10

const MESSAGE_CHOKE = 0
const MESSAGE_UNCHOKE = 1
const MESSAGE_INTERESTED = 2
const MESSAGE_HAVE = 4
const MESSAGE_BITFIELD = 5
const MESSAGE_REQUEST = 6
const MESSAGE_PIECE = 7
const MESSAGE_CANCEL = 8
const MESSAGE_EXTENDED = 20

const EXTENDED_HANDSHAKE_ID = 0
/** The ut_metadata id we advertise for peers to send metadata back on. Ours to choose. */
const OUR_UT_METADATA_ID = 1

const UT_METADATA_REQUEST = 0
const UT_METADATA_DATA = 1
const UT_METADATA_REJECT = 2

/** BEP 9 fixes metadata pieces at 16 KiB, independent of the torrent's own piece length. */
export const METADATA_PIECE_BYTES = 16 * 1024

// Most peers a tracker hands out are stale — firewalled, long gone, or simply not listening.
// Waiting on them is the main cost of finding the few that answer, so this is deliberately
// impatient compared to the stall budget that applies once a peer is actually talking.
const CONNECT_TIMEOUT_MS = 6_000

// A peer that accepts the connection and then goes quiet — no data, no error, no close —
// would otherwise hold a worker slot forever. Same reasoning as the HTTP chunk downloader's
// stall timeout, and the same 20s budget.
const STALL_TIMEOUT_MS = 20_000

// Bounds what one message can make us buffer. The largest legitimate message is a piece
// (16 KiB payload) or a metadata reply (16 KiB plus a small bencoded header).
const MAX_MESSAGE_BYTES = 64 * 1024

export interface PieceBlock {
  index: number
  begin: number
  data: Buffer
}

/**
 * One outbound BitTorrent peer connection, sourced from a chosen local interface.
 *
 * Deliberately a pure leecher: it never advertises pieces and never serves a request, so
 * there is no upload path here. Handlers are plain assignable properties rather than an
 * EventEmitter so the session's callbacks stay type-checked.
 */
export class PeerConnection {
  readonly peer: PeerAddress
  readonly interfaceId: string

  /** Set once the peer has unchoked us and is ready to serve block requests. */
  onReady?: () => void
  /** The peer told us how large the metadata is (its extended handshake). */
  onMetadataSize?: (totalBytes: number) => void
  onMetadataPiece?: (index: number, data: Buffer) => void
  onPieceBlock?: (block: PieceBlock) => void
  /** Raw bytes arrived — reported separately from completed blocks so throughput reflects
   * what the interface actually moved, including data for a piece that later fails its hash. */
  onBytes?: (deltaBytes: number) => void
  /** Fired once per piece the peer newly advertises, for each entry of a bitfield as well as
   * for a single `have`. One callback per piece (rather than one per message) is what lets
   * the session keep exact availability counts for rarest-first picking. */
  onHavePiece?: (index: number) => void
  onClose?: (error?: Error) => void

  private readonly options: PeerConnectionOptions
  private socket: Socket | null = null
  private buffered: Buffer = Buffer.alloc(0)
  private handshakeReceived = false
  private closed = false

  /** Peer-chokes-us. Starts true: a peer serves nothing until it unchokes. */
  private peerChoking = true
  private available = new Set<number>()
  private supportsExtended = false
  private peerMetadataId: number | null = null
  private inFlightRequests = 0

  constructor(options: PeerConnectionOptions) {
    this.options = options
    this.peer = options.peer
    this.interfaceId = options.interfaceId
  }

  get isChoked(): boolean {
    return this.peerChoking
  }

  get isConnected(): boolean {
    return !this.closed && this.handshakeReceived
  }

  get inFlight(): number {
    return this.inFlightRequests
  }

  /** Whether this peer advertised piece `index`. */
  hasPiece(index: number): boolean {
    return this.available.has(index)
  }

  /** Every piece this peer advertised. The session walks this on disconnect to undo the
   * availability counts the peer contributed. */
  availablePieces(): Iterable<number> {
    return this.available
  }

  // A bitfield's trailing bits can run past the real piece count, and a magnet peer can
  // advertise before the metadata that would bound it has arrived, so nothing is filtered
  // here — the session ignores indices outside the torrent.
  private addAvailable(index: number): void {
    if (this.available.has(index)) return
    this.available.add(index)
    this.onHavePiece?.(index)
  }

  /** True once the peer has agreed to the extension protocol and named its ut_metadata id. */
  get canRequestMetadata(): boolean {
    return this.isConnected && this.peerMetadataId !== null
  }

  connect(): void {
    const socket = connect({
      host: this.peer.host,
      port: this.peer.port,
      localAddress: this.options.localAddress,
      family: 4
    })
    this.socket = socket

    // Tightened to the stall budget once the peer is actually talking to us; until then
    // this is the connect timeout.
    socket.setTimeout(CONNECT_TIMEOUT_MS)

    socket.on('connect', () => {
      socket.setTimeout(STALL_TIMEOUT_MS)
      socket.write(this.buildHandshake())
    })
    socket.on('data', (data: Buffer) => this.onData(data))
    socket.on('timeout', () => this.destroy(new Error('Peer stalled')))
    socket.on('error', (error: Error) => this.destroy(error))
    socket.on('close', () => this.destroy())
  }

  destroy(error?: Error): void {
    if (this.closed) return
    this.closed = true

    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }

    // Released so the session can re-issue them to another peer rather than waiting out
    // requests that will never be answered.
    this.inFlightRequests = 0
    this.buffered = Buffer.alloc(0)
    this.onClose?.(error)
  }

  private buildHandshake(): Buffer {
    const handshake = Buffer.alloc(HANDSHAKE_BYTES)
    handshake.writeUInt8(PROTOCOL_NAME.length, 0)
    handshake.write(PROTOCOL_NAME, 1, 'latin1')
    handshake[RESERVED_OFFSET + RESERVED_EXTENDED_BYTE] = RESERVED_EXTENDED_MASK
    this.options.infoHash.copy(handshake, INFO_HASH_OFFSET)
    this.options.peerId.copy(handshake, INFO_HASH_OFFSET + 20)
    return handshake
  }

  private send(id: number, payload?: Buffer): void {
    if (this.closed || !this.socket) return
    const body = payload ?? Buffer.alloc(0)
    const message = Buffer.alloc(5 + body.length)
    message.writeUInt32BE(1 + body.length, 0)
    message.writeUInt8(id, 4)
    body.copy(message, 5)
    this.socket.write(message)
  }

  /** Asks for a 16 KiB slice of piece `index`. The session owns pipeline depth. */
  requestBlock(index: number, begin: number, length: number): void {
    const payload = Buffer.alloc(12)
    payload.writeUInt32BE(index, 0)
    payload.writeUInt32BE(begin, 4)
    payload.writeUInt32BE(length, 8)
    this.inFlightRequests += 1
    this.send(MESSAGE_REQUEST, payload)
  }

  cancelBlock(index: number, begin: number, length: number): void {
    const payload = Buffer.alloc(12)
    payload.writeUInt32BE(index, 0)
    payload.writeUInt32BE(begin, 4)
    payload.writeUInt32BE(length, 8)
    this.send(MESSAGE_CANCEL, payload)
  }

  requestMetadataPiece(index: number): void {
    if (this.peerMetadataId === null) return
    const header = encode({ msg_type: UT_METADATA_REQUEST, piece: index })
    this.send(MESSAGE_EXTENDED, Buffer.concat([Buffer.from([this.peerMetadataId]), header]))
  }

  private onData(data: Buffer): void {
    if (this.closed) return
    this.onBytes?.(data.length)
    this.buffered = Buffer.concat([this.buffered, data])
    this.consume()
  }

  private consume(): void {
    if (!this.handshakeReceived) {
      if (this.buffered.length < HANDSHAKE_BYTES) return
      if (!this.verifyHandshake(this.buffered.subarray(0, HANDSHAKE_BYTES))) return
      this.buffered = this.buffered.subarray(HANDSHAKE_BYTES)
      this.handshakeReceived = true

      if (this.supportsExtended) this.sendExtendedHandshake()
      this.send(MESSAGE_INTERESTED)
    }

    while (!this.closed && this.buffered.length >= 4) {
      const length = this.buffered.readUInt32BE(0)

      if (length > MAX_MESSAGE_BYTES) {
        this.destroy(new Error(`Peer sent an oversized message (${length} bytes)`))
        return
      }
      if (this.buffered.length < 4 + length) return

      // A zero-length message is a keep-alive: nothing to handle, but it does count as the
      // peer being alive, which the socket timeout already reset on arrival.
      if (length > 0) {
        const message = this.buffered.subarray(4, 4 + length)
        this.handleMessage(message.readUInt8(0), message.subarray(1))
      }
      this.buffered = this.buffered.subarray(4 + length)
    }
  }

  private verifyHandshake(handshake: Buffer): boolean {
    const nameLength = handshake.readUInt8(0)
    const name = handshake.toString('latin1', 1, 1 + nameLength)
    if (nameLength !== PROTOCOL_NAME.length || name !== PROTOCOL_NAME) {
      this.destroy(new Error('Peer is not speaking the BitTorrent protocol'))
      return false
    }

    // A peer serving a different torrent would answer our requests with bytes for the
    // wrong content, and those bytes would only be caught later by a piece hash failure.
    const infoHash = handshake.subarray(INFO_HASH_OFFSET, INFO_HASH_OFFSET + 20)
    if (!infoHash.equals(this.options.infoHash)) {
      this.destroy(new Error('Peer answered for a different torrent'))
      return false
    }

    this.supportsExtended =
      (handshake[RESERVED_OFFSET + RESERVED_EXTENDED_BYTE] & RESERVED_EXTENDED_MASK) !== 0
    return true
  }

  private sendExtendedHandshake(): void {
    const payload = encode({ m: { ut_metadata: OUR_UT_METADATA_ID }, v: 'Plexo/1.0' })
    this.send(MESSAGE_EXTENDED, Buffer.concat([Buffer.from([EXTENDED_HANDSHAKE_ID]), payload]))
  }

  private handleMessage(id: number, payload: Buffer): void {
    switch (id) {
      case MESSAGE_CHOKE:
        this.peerChoking = true
        // A choking peer discards everything it had queued for us, so those requests are
        // gone rather than merely slow — drop the count so the session re-issues them.
        this.inFlightRequests = 0
        return

      case MESSAGE_UNCHOKE:
        if (!this.peerChoking) return
        this.peerChoking = false
        this.onReady?.()
        return

      case MESSAGE_HAVE: {
        if (payload.length < 4) return
        this.addAvailable(payload.readUInt32BE(0))
        return
      }

      case MESSAGE_BITFIELD: {
        for (let byteIndex = 0; byteIndex < payload.length; byteIndex += 1) {
          const byte = payload[byteIndex]
          if (byte === 0) continue
          // Most-significant bit first, per the spec.
          for (let bit = 0; bit < 8; bit += 1) {
            if (byte & (0x80 >> bit)) this.addAvailable(byteIndex * 8 + bit)
          }
        }
        return
      }

      case MESSAGE_PIECE: {
        if (payload.length < 8) return
        if (this.inFlightRequests > 0) this.inFlightRequests -= 1
        this.onPieceBlock?.({
          index: payload.readUInt32BE(0),
          begin: payload.readUInt32BE(4),
          data: Buffer.from(payload.subarray(8))
        })
        return
      }

      case MESSAGE_EXTENDED:
        this.handleExtended(payload)
        return

      default:
        // Anything else (port, cancel, or a fast-extension message we never asked for) is
        // irrelevant to a leecher and safe to skip.
        return
    }
  }

  private handleExtended(payload: Buffer): void {
    if (payload.length < 1) return
    const extendedId = payload.readUInt8(0)
    const body = payload.subarray(1)

    if (extendedId === EXTENDED_HANDSHAKE_ID) {
      this.handleExtendedHandshake(body)
      return
    }

    // The only extension we advertised is ut_metadata, so anything arriving on our declared
    // id is a metadata message and anything else is not for us.
    if (extendedId === OUR_UT_METADATA_ID) this.handleMetadataMessage(body)
  }

  private handleExtendedHandshake(body: Buffer): void {
    let decoded: ReturnType<typeof decodePrefix>
    try {
      decoded = decodePrefix(body)
    } catch {
      // A peer that can't produce a valid handshake is not worth keeping a slot open for.
      this.destroy(new Error('Peer sent a malformed extended handshake'))
      return
    }

    if (!isDict(decoded.value)) return

    const extensions = decoded.value['m']
    if (isDict(extensions)) {
      const metadataId = dictNumber(extensions, 'ut_metadata')
      // Advertising id 0 means the peer is explicitly *not* offering the extension.
      if (metadataId !== null && metadataId > 0) this.peerMetadataId = metadataId
    }

    const metadataSize = dictNumber(decoded.value, 'metadata_size')
    if (metadataSize !== null && metadataSize > 0) this.onMetadataSize?.(metadataSize)
  }

  private handleMetadataMessage(body: Buffer): void {
    let decoded: ReturnType<typeof decodePrefix>
    try {
      decoded = decodePrefix(body)
    } catch {
      return
    }

    if (!isDict(decoded.value)) return

    const messageType = dictNumber(decoded.value, 'msg_type')
    const pieceIndex = dictNumber(decoded.value, 'piece')
    if (pieceIndex === null) return

    if (messageType === UT_METADATA_REJECT) {
      this.peerMetadataId = null
      return
    }

    // A request would be us serving metadata, which a leecher that has none cannot do.
    if (messageType !== UT_METADATA_DATA) return

    // The payload follows the bencoded header directly, un-bencoded — which is why the
    // decoder reports how many bytes the header used.
    this.onMetadataPiece?.(pieceIndex, Buffer.from(body.subarray(decoded.bytesRead)))
  }
}
