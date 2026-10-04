import { isIP, Socket } from 'node:net'
import { basename, dirname } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { Store, Torrent, Wire } from 'webtorrent'
import type { TorrentDownloadNetwork, TorrentPeerState } from '../../../shared/types'
import { connectRoute } from '../../network/deviceBinding'
import { routesFor, type NetworkRoute } from '../../network/routes'
import {
  recomputeAggregates,
  type Transfer,
  type TransferHost,
  type TorrentTransferTarget
} from '../transfer'
import { createClient, loadClientNamer, storeNamed } from './engine'
import { bitfieldOf, creditPiece, pickNetwork } from './peers'

/** Peers each network in use may have at once (webtorrent's maxConns is this times the networks). */
const PEERS_PER_NETWORK = 30
// A network that has dialled this many peers with none answering, for this long, while another
// network has peers, can't reach the swarm. It keeps one dial going, to see when it can again.
const UNREACHABLE_AFTER_ATTEMPTS = 5
const UNREACHABLE_AFTER_MS = 60_000

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** webtorrent's name for a peer: what it hands the hook as host and port, and the 'wire' event as
 * an address. */
const addressOf = (host: string, port: number): string =>
  isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`

interface Peer {
  state: TorrentPeerState
}

/**
 * Fetches a torrent with webtorrent, every peer pinned to one network. webtorrent finds the peers
 * and runs the protocol; each time it dials one, its `connect` hook (see engine.ts and
 * patches/webtorrent+3.0.21.patch) asks this transfer which network to use, and the socket comes
 * from connectRoute, as HTTP's do. Peers expose connection telemetry only; a piece is credited to
 * the networks that delivered it once webtorrent has verified it and written it to disk.
 *
 * One webtorrent client per run: a pause destroys it, files kept, and a resume starts a new one
 * from the pieces already done.
 */
export class TorrentTransfer implements Transfer {
  private client: WebTorrent | null = null
  /** Destroys this run's client; safe to repeat. */
  private closeClient: (() => void) | null = null
  /** Settles once this run's client is gone. Null between runs. */
  private ended: Promise<void> | null = null
  private peers = new Map<Wire, Peer>()
  private nextPeerId = 0
  /** webtorrent's file store, writing under the download's name; loaded with the first run. */
  private store: Store | null = null
  /** The run's torrent, once ready for its files to be chosen. */
  private torrent: Torrent | null = null
  /** Names a peer's client from its peer id; loaded with the first run. */
  private nameClient: ((peerId: string) => string | null) | null = null
  /** The network each peer is on, by webtorrent's address for it: dialled through, or dialled in
   * on. */
  private chosen = new Map<string, string>()
  /** Dials in flight, by network. */
  private dialling = new Map<string, number>()
  /** By network: dials since a peer last answered, and when one last did. */
  private reach = new Map<string, { dials: number; answeredAt: number }>()
  /** Bytes of each piece not verified yet, by network. */
  private unverified = new Map<number, Record<string, number>>()

  constructor(
    private readonly runtime: TorrentTransferTarget,
    private readonly host: TransferHost,
    private readonly torrentFile: Uint8Array,
    /** The download, in place: the torrent's folder or file (TorrentDestination.path). */
    private readonly destination: string
  ) {}

  reconcile(): void {
    const usable = this.usable()
    if (!this.ended) this.ended = this.run()
    if (this.client) this.client.maxConns = PEERS_PER_NETWORK * usable.length
    // A network switched off, or gone, takes its peers with it.
    for (const [wire, peer] of this.peers) {
      if (!usable.some((network) => network.id === peer.state.interfaceId)) wire.destroy()
    }
  }

  tick(now: number): void {
    const withPeers = new Set([...this.peers.values()].map((peer) => peer.state.interfaceId))
    for (const network of this.usable()) {
      const reach = this.reachOf(network.id, now)
      if (
        network.status === 'on' &&
        reach.dials >= UNREACHABLE_AFTER_ATTEMPTS &&
        now - reach.answeredAt >= UNREACHABLE_AFTER_MS &&
        !withPeers.has(network.id) &&
        withPeers.size > 0
      ) {
        network.status = 'unreachable'
        this.host.scheduleUpdate()
      }
    }
    for (const peer of this.peers.values()) {
      const status = peer.state.speedBytesPerSec > 0 ? 'receiving' : 'connected'
      if (peer.state.status !== status) {
        peer.state.status = status
        this.host.scheduleUpdate()
      }
    }
    this.host.reconcile()
  }

  running(): Iterable<Promise<void>> {
    return this.ended ? [this.ended] : []
  }

  abort(): void {
    this.closeClient?.()
  }

  reset(): void {
    this.chosen.clear()
    this.dialling.clear()
    this.reach.clear()
    // webtorrent drops what it had of unfinished pieces with its client.
    this.unverified.clear()
    for (const piece of this.runtime.pieces) {
      piece.provisionalBytes = 0
      if (piece.status === 'downloading') piece.status = 'pending'
    }
  }

  wake(_pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void {
    // Peers on a network whose address changed are on dead sockets; webtorrent dials new ones.
    for (const [wire, peer] of this.peers) if (reconnect(peer.state.interfaceId)) wire.destroy()
  }

  systemResumed(now: number): void {
    // Time asleep says nothing about whether a network can reach the swarm.
    for (const reach of this.reach.values()) reach.answeredAt = now
  }

  /** One run: a client added to the torrent, until the run stops (pause, cancel, error, done).
   * Settles once the client is destroyed and its files closed. */
  private async run(): Promise<void> {
    const stop = this.runtime.stop.signal
    try {
      this.nameClient ??= await loadClientNamer()
      this.store ??= await storeNamed(basename(this.destination), (path) =>
        this.runtime.file.written.add(path)
      )
      const client = await createClient({
        connect: (options) => this.connect(options),
        maxConns: PEERS_PER_NETWORK * Math.max(1, this.usable().length)
      })
      await new Promise<void>((resolve) => {
        let closing = false
        const close = (): void => {
          if (closing) return
          closing = true
          this.client = null
          this.closeClient = null
          // After a fatal error webtorrent has already torn itself down.
          if (client.destroyed) resolve()
          else client.destroy(() => resolve())
        }
        if (stop.aborted) return close()
        this.client = client
        this.closeClient = close
        stop.addEventListener('abort', close, { once: true })
        client.on('error', (error: unknown) => {
          this.host.failDownload(message(error))
          close()
        })
        client._connPool?.tcpServer.on('connection', (socket: Socket) => this.onIncoming(socket))
        this.add(client)
      })
    } catch (error) {
      this.host.failDownload(message(error))
    } finally {
      for (const peer of this.peers.values()) this.removePeer(peer)
      this.peers.clear()
      this.torrent = null
      this.ended = null
    }
  }

  /** The choice of files changed (requestPayload.selectedFiles): the engine fetches for the new
   * one now. Not running, the next run starts with it. */
  filesChosen(): void {
    if (this.torrent) this.selectFiles(this.torrent)
  }

  /** Asks the engine for the chosen files' pieces only, all of them with no choice made. What it
   * fetched before stays: a deselected piece just isn't asked for. */
  private selectFiles(torrent: Torrent): void {
    const chosen = this.runtime.requestPayload.selectedFiles
    if (torrent.pieces.length > 0) torrent.deselect(0, torrent.pieces.length - 1)
    torrent.files.forEach((file, index) => {
      if (!chosen || chosen.includes(index)) file.select()
    })
  }

  /** A peer took `bytes` of a piece from this download, over `network`. */
  private onUpload(network: TorrentDownloadNetwork, peer: Peer, bytes: number): void {
    const { state } = this.runtime
    network.bytesUploaded += bytes
    state.bytesUploaded += bytes
    peer.state.bytesUploaded += bytes
    // Read as speeds on the download's clock (see updateSpeeds).
    this.runtime.uploadMeters.add(peer.state.id, network.id, bytes)
    this.host.scheduleUpdate()
  }

  private add(client: WebTorrent): void {
    const torrent = client.add(this.torrentFile, {
      path: dirname(this.destination),
      store: this.store!,
      // Trusted as done, bar a hash check of a piece or two per file (more if one fails).
      bitfield: bitfieldOf(this.runtime.pieces.map((block) => block.status === 'completed')),
      // Nothing until webtorrent is ready to be told which files (below), as on a change.
      deselect: true
    })
    torrent.on('wire', (wire: Wire, address: string) => this.onWire(wire, address))
    torrent.on('verified', (index: number) => this.onVerified(index))
    torrent.once('ready', () => {
      this.torrent = torrent
      this.selectFiles(torrent)
      this.followEngine(torrent)
    })
    torrent.on('error', (error: unknown) => this.host.failDownload(message(error)))
  }

  /** The networks peers may use now. One that can't reach the swarm stays, for its one dial. */
  private usable(): TorrentDownloadNetwork[] {
    return this.runtime.state.networks.filter(
      (network) => network.status === 'on' || network.status === 'unreachable'
    )
  }

  private reachOf(networkId: string, now = Date.now()): { dials: number; answeredAt: number } {
    let reach = this.reach.get(networkId)
    if (!reach) this.reach.set(networkId, (reach = { dials: 0, answeredAt: now }))
    return reach
  }

  /** webtorrent's `connect` hook: every outgoing peer comes through here. */
  private connect({ host: address, port }: { host: string; port: number }): Socket {
    // A peer named by hostname (a magnet's x.pe can be) has no family: no network takes it.
    const family = isIP(address) as 0 | 4 | 6
    const peersOn = (id: string): number =>
      (this.dialling.get(id) ?? 0) +
      [...this.peers.values()].filter((peer) => peer.state.interfaceId === id).length
    const routes = new Map<string, NetworkRoute>()
    for (const network of this.usable()) {
      const iface = this.host.networks.find(network.id)
      const route = family ? iface && routesFor(iface, [{ address, family }])[0] : undefined
      if (!route) continue
      // An unreachable network gets one dial at a time, to find out when it's back.
      if (network.status === 'unreachable' && peersOn(network.id) > 0) continue
      routes.set(network.id, route)
    }
    const networkId = pickNetwork([...routes.keys()].map((id) => ({ id, peers: peersOn(id) })))
    if (!networkId) {
      const socket = new Socket()
      process.nextTick(() => socket.destroy(new Error('No network in use can reach this peer')))
      return socket
    }

    this.chosen.set(addressOf(address, port), networkId)
    this.dialling.set(networkId, (this.dialling.get(networkId) ?? 0) + 1)
    this.reachOf(networkId).dials += 1
    const socket = connectRoute(routes.get(networkId)!, port)
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      this.dialling.set(networkId, (this.dialling.get(networkId) ?? 1) - 1)
    }
    socket.once('connect', settle)
    socket.once('close', settle)
    this.limit(socket, networkId)
    return socket
  }

  /** Puts what a peer sends through the speed and data limits (see Limits). push() is where
   * the socket's bytes come in, whoever is reading them: a 'data' listener here would set it
   * flowing before webtorrent is ready to read. */
  private limit(socket: Socket, networkId: string): void {
    const push = socket.push.bind(socket)
    socket.push = (chunk: Buffer | null, encoding?: BufferEncoding): boolean => {
      const wait = chunk ? this.host.limits.take(networkId, chunk.length) : 0
      if (wait > 0) {
        // ponytail: webtorrent's pipe resumes the socket when its wire drains, which can cut a
        // wait short; the debt it leaves only lengthens the next one, so the rate still holds.
        socket.pause()
        setTimeout(() => socket.resume(), wait)
      }
      return push(chunk, encoding)
    }
  }

  /** A peer dialling in: it's on the network whose address it reached. One that reached no
   * network in use isn't put on any, and onWire drops it. */
  private onIncoming(socket: Socket): void {
    // A dual-stack server sees IPv4 as IPv4-mapped IPv6.
    const local = socket.localAddress?.replace(/^::ffff:/, '')
    const network = this.usable().find((entry) =>
      this.host.networks.find(entry.id)?.addresses.some((address) => address.address === local)
    )
    // As webtorrent names an incoming peer: the address as the socket gives it, no brackets.
    if (!network) return
    this.chosen.set(`${socket.remoteAddress}:${socket.remotePort}`, network.id)
    this.limit(socket, network.id)
  }

  private onWire(wire: Wire, address: string): void {
    const networkId = this.chosen.get(address)
    const network = this.runtime.state.networks.find((entry) => entry.id === networkId)
    if (!network) {
      wire.destroy()
      return
    }
    // Every network uploads, whatever its kind: each has an address of its own, and webtorrent's
    // tit-for-tat gives a network's peers back what they send it.

    const reach = this.reachOf(network.id)
    reach.dials = 0
    reach.answeredAt = Date.now()
    if (network.status === 'unreachable') network.status = 'on'

    const peerState: TorrentPeerState = {
      id: this.nextPeerId++,
      interfaceId: network.id,
      status: 'connected',
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      bytesUploaded: 0,
      uploadSpeedBytesPerSec: 0,
      client: wire.peerId ? (this.nameClient?.(wire.peerId) ?? null) : null
    }
    const peer: Peer = { state: peerState }
    this.peers.set(wire, peer)
    const { state } = this.runtime
    state.peers.push(peerState)
    state.peakPeers = Math.max(state.peakPeers, state.peers.length)

    wire.on('piece', (index: number, _offset: number, buffer: Uint8Array) => {
      peerState.bytesDownloaded += buffer.length
      peerState.status = 'receiving'
      const pending = this.unverified.get(index) ?? {}
      pending[network.id] = (pending[network.id] ?? 0) + buffer.length
      this.unverified.set(index, pending)
      const piece = this.runtime.pieces[index]
      if (piece) {
        // In flight now; it counts once verified (onVerified).
        if (piece.status === 'pending') {
          piece.status = 'downloading'
          piece.interfaceId = network.id
        }
        const provisional = Object.values(pending).reduce((sum, bytes) => sum + bytes, 0)
        const length = piece.rangeEnd === null ? 0 : piece.rangeEnd - piece.rangeStart + 1
        piece.provisionalBytes = Math.min(length, provisional)
      }
      this.runtime.meters.add(peerState.id, network.id, buffer.length)
      this.host.scheduleUpdate()
    })
    wire.on('upload', (bytes: number) => this.onUpload(network, peer, bytes))
    wire.once('close', () => {
      if (this.peers.delete(wire)) this.removePeer(peer)
    })
    this.host.scheduleUpdate()
  }

  private removePeer(peer: Peer): void {
    const { peers } = this.runtime.state
    const index = peers.indexOf(peer.state)
    if (index >= 0) peers.splice(index, 1)
    this.runtime.meters.connections.delete(peer.state.id)
    this.runtime.uploadMeters.connections.delete(peer.state.id)
    this.host.scheduleUpdate()
  }

  /** A piece verified and written: it counts now, credited to the networks that delivered it. */
  private onVerified(index: number): void {
    const piece = this.runtime.pieces[index]
    const received = this.unverified.get(index) ?? {}
    this.unverified.delete(index)
    // A skipped piece fetched anyway isn't this download's: nothing chosen needs it.
    if (!piece || piece.status === 'completed' || piece.status === 'skipped') return
    if (piece.rangeEnd === null) return
    const { state } = this.runtime
    const length = piece.rangeEnd - piece.rangeStart + 1
    // Found on disk rather than received: whoever held it last, else the first network in use.
    const fallback = piece.interfaceId ?? this.usable()[0]?.id ?? state.networks[0].id
    const shares = creditPiece(received, length, fallback)
    state.bytesDownloaded += length - piece.bytesDownloaded
    for (const [id, bytes] of Object.entries(piece.bytesByInterface)) {
      const network = state.networks.find((entry) => entry.id === id)
      if (network) network.bytesDownloaded -= bytes
    }
    for (const [id, bytes] of Object.entries(shares)) {
      const network = state.networks.find((entry) => entry.id === id)
      if (network) network.bytesDownloaded += bytes
    }
    piece.bytesByInterface = shares
    piece.bytesDownloaded = length
    piece.provisionalBytes = 0
    piece.interfaceId = Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0]
    piece.status = 'completed'
    this.host.scheduleUpdate()
  }

  /**
   * Once webtorrent has checked what is on disk: a piece it found wanting, though this download
   * had it as done, is fetched again — and isn't done here either, or the download would be
   * published without it.
   */
  private followEngine(torrent: Torrent): void {
    let changed = false
    for (const piece of this.runtime.pieces) {
      if (piece.status === 'completed' && !torrent.bitfield.get(piece.index)) {
        piece.status = 'pending'
        piece.bytesDownloaded = 0
        piece.provisionalBytes = 0
        piece.bytesByInterface = {}
        changed = true
      }
    }
    if (changed) {
      recomputeAggregates(this.runtime.state, this.runtime.pieces)
      this.host.scheduleUpdate()
    }
  }
}
