import { createHash } from 'node:crypto'
import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { InterfaceHealth, type TorrentInterface } from './interfaceHealth'
import type { MagnetLink } from './magnet'
import { discoverPeers } from './metadata'
import { PeerConnection, type PieceBlock } from './peerConnection'
import { generatePeerId, type PeerAddress } from './trackerClient'
import { pieceLengthAt, type TorrentInfo } from './torrentInfo'

/** One peer slot, pinned to a network interface for its whole life. The manager creates one
 * per parallel connection per selected network, mirroring how HTTP chunk workers are laid
 * out, so a torrent's bytes get attributed to networks the same way. */
export interface TorrentSlot {
  id: number
  interfaceId: string
  localAddress: string
}

export interface TorrentSlotState {
  connected: boolean
  /** Piece this slot is currently pulling, or null when idle. */
  pieceIndex: number | null
  /** `host:port` of the peer the slot holds, for display. */
  peer: string | null
}

export interface TorrentSessionOptions {
  magnet: MagnetLink
  info: TorrentInfo
  /** Directory the verified `part-N` files are written into. */
  partsDir: string
  slots: TorrentSlot[]
  /** Piece indices already verified on disk by an earlier run. */
  completedPieces: number[]
  signal: AbortSignal
  /** Bytes of `pieceIndex` just delivered by `slotId`'s peer. */
  onProgress: (slotId: number, pieceIndex: number, deltaBytes: number) => void
  /** A piece's buffered bytes were discarded, so progress already reported for it has to be
   * taken back — see `finalizePiece`. */
  onPieceReset: (pieceIndex: number) => void
  onPieceComplete: (pieceIndex: number) => void
  onSlotChanged: (slotId: number, state: TorrentSlotState) => void
}

/** The de-facto standard request size. Peers commonly reject anything larger. */
const BLOCK_BYTES = 16 * 1024

/** Outstanding requests per peer. Deep enough to keep a fast peer's pipe full across a
 * round trip, shallow enough that losing a peer doesn't strand much work. */
const PIPELINE_DEPTH = 16

const ANNOUNCE_INTERVAL_MS = 60_000

/**
 * Floor between announces, including the ones triggered by peers dropping.
 *
 * Slots refill on every disconnect, and with a large peer budget disconnects arrive in
 * bursts — without a floor, an exhausted queue would re-announce continuously, which is how
 * a client gets itself rate-limited or banned by a tracker.
 */
const MIN_ANNOUNCE_INTERVAL_MS = 25_000

/**
 * How long to keep a peer that has never unchoked us.
 *
 * A peer only serves data once it unchokes, and one that never does still sends keep-alives
 * — so it looks alive to the socket timeout while occupying a slot and delivering nothing.
 * Seeds generally unchoke within a rotation or two; a peer that hasn't by now is better
 * replaced by one from the queue that might.
 */
const CHOKE_PATIENCE_MS = 45_000

// A swarm that hands us nothing for this long isn't going to recover on its own, and an
// error the user can see beats a progress bar that sits at the same number forever.
const NO_PROGRESS_TIMEOUT_MS = 180_000

const PROGRESS_WATCHDOG_INTERVAL_MS = 15_000

/**
 * How long a peer rests before it may be dialed again.
 *
 * A peer used to be dialed at most once per download: its address went into a set on dial and
 * only ever came back out if the *network* had been at fault. Every other ending — refused,
 * timed out, stalled, never unchoked, or simply a good peer that finished with us and closed
 * — burned it permanently, and re-announces filter out everything already dialed. So the
 * queue drained towards empty, freed slots stayed free, and the download decayed onto
 * whichever network's peers happened to survive longest. That decay is most of what "not
 * reliably using more than one network" looks like from the outside: it starts balanced and
 * quietly stops being so.
 *
 * Resting a peer instead of banning it keeps the swarm's roster reusable, which is what lets
 * an idle network refill. The three budgets differ because the endings mean different things:
 * a peer that actually served us is the most valuable thing we have and has usually just
 * rotated its upload slots; one that never answered is probably firewalled or gone; one that
 * sent bytes failing a piece hash is actively costing us work.
 */
const PEER_RETRY_AFTER_SERVING_MS = 30_000
const PEER_RETRY_BASE_MS = 60_000
const PEER_RETRY_MAX_MS = 15 * 60_000
const PEER_RETRY_CORRUPT_MS = 30 * 60_000

/** Ceiling on the remembered roster. A swarm is a few hundred peers, so this is only a guard
 * against a tracker rotating a long tail of dead addresses through a multi-hour download. */
const MAX_KNOWN_PEERS = 2048

interface PieceBuffer {
  data: Buffer
  receivedBlocks: boolean[]
  remainingBlocks: number
  /** Slots whose peers supplied bytes for this piece — the suspects if it fails its hash. */
  contributors: Set<number>
  /** Set while the piece is being hashed and written, so a duplicate final block arriving
   * in endgame can't finalize it twice. */
  finalizing: boolean
}

/**
 * Downloads one torrent's pieces across a fixed set of per-interface peer slots.
 *
 * The design mirrors Plexo's HTTP engine closely enough to reuse its whole progress model:
 * a torrent piece plays the part of a block, and a peer connection plays the part of a chunk
 * worker bound to one network. Pieces are hashed before they are written, which makes this
 * engine strictly safer than the HTTP one — there is no need for the ETag/Last-Modified
 * dance on resume, because a piece that doesn't match its SHA-1 never reaches the disk.
 *
 * This is a leech-only client: it never advertises pieces and never serves a request.
 */
export class TorrentSession {
  private readonly options: TorrentSessionOptions
  private readonly peerId = generatePeerId()
  private readonly pieceCount: number
  private readonly completed: boolean[]
  private readonly availability: Uint32Array
  private readonly pieces = new Map<number, PieceBuffer>()
  /** pieceIndex -> slot ids currently pulling it. */
  private readonly assignments = new Map<number, Set<number>>()
  private readonly connections = new Map<number, PeerConnection>()
  private readonly slotPiece = new Map<number, number>()
  /** slotId -> block offsets already requested for its current piece. */
  private readonly requestedBlocks = new Map<number, Set<number>>()

  private readonly health: InterfaceHealth
  private peerQueue: PeerAddress[] = []
  /** Every peer any tracker has named, `host:port` -> address. The swarm's roster, which is
   * what makes a peer re-dialable after its cooldown rather than gone for good. */
  private readonly knownPeers = new Map<string, PeerAddress>()
  /** Peers currently queued or held by a connection, so they aren't dialed twice at once. */
  private readonly peersInHand = new Set<string>()
  /** `host:port` -> the earliest time it may be dialed again. */
  private readonly peerRetryAfter = new Map<string, number>()
  /** Consecutive disappointments per peer, which its cooldown backs off against. */
  private readonly peerFailures = new Map<string, number>()
  /** Peers that contributed to a piece which then failed its hash, resolved on disconnect. */
  private readonly poisonedPeers = new Set<string>()
  private remainingPieces: number
  private lastProgressAt = Date.now()
  private settled = false
  private announceTimer?: NodeJS.Timeout
  private watchdogTimer?: NodeJS.Timeout
  private announceInFlight = false
  private lastAnnounceAt = 0
  /** slotId -> when its peer connected, for retiring peers that never unchoke. */
  private readonly connectedAt = new Map<number, number>()
  private resolveRun: (() => void) | null = null
  private rejectRun: ((error: Error) => void) | null = null

  constructor(options: TorrentSessionOptions) {
    this.options = options

    // Slots are pinned to networks, so the distinct networks behind them are what health is
    // tracked against — one unroutable adapter must not keep consuming peers through every
    // slot that happens to be bound to it.
    const byInterface = new Map<string, TorrentInterface>()
    for (const slot of options.slots) {
      byInterface.set(slot.interfaceId, { id: slot.interfaceId, address: slot.localAddress })
    }
    this.health = new InterfaceHealth([...byInterface.values()])

    this.pieceCount = options.info.pieceHashes.length
    this.completed = new Array<boolean>(this.pieceCount).fill(false)
    this.availability = new Uint32Array(this.pieceCount)

    for (const index of options.completedPieces) {
      if (index >= 0 && index < this.pieceCount) this.completed[index] = true
    }
    this.remainingPieces = this.completed.filter((done) => !done).length
  }

  /** Resolves when every piece is verified on disk; rejects on abort or a fatal swarm error. */
  async run(): Promise<void> {
    await this.reconcileCompletedPieces()
    if (this.remainingPieces === 0) return

    const { signal } = this.options
    if (signal.aborted) throw new Error('Download aborted')

    return new Promise<void>((resolve, reject) => {
      this.resolveRun = resolve
      this.rejectRun = reject

      const onAbort = (): void => this.settle(new Error('Download aborted'))
      signal.addEventListener('abort', onAbort, { once: true })

      this.watchdogTimer = setInterval(() => {
        this.retireChokedPeers()
        // Both recoveries in this engine are time-based — a peer coming off its cooldown, a
        // network coming off probation — and nothing else would notice either. Refills
        // otherwise only happen on a disconnect or an announce, so a network that lost all
        // its peers at once would sit idle until the next announce even with peers waiting.
        this.requeuePeers()
        this.fillSlots()
        if (Date.now() - this.lastProgressAt < NO_PROGRESS_TIMEOUT_MS) return
        this.settle(
          new Error(
            'No peer has sent any data for three minutes — this torrent may have no active seeds'
          )
        )
      }, PROGRESS_WATCHDOG_INTERVAL_MS)

      this.announceTimer = setInterval(() => void this.refreshPeers(), ANNOUNCE_INTERVAL_MS)

      void this.refreshPeers().then(() => {
        if (!this.settled && this.peerQueue.length === 0 && this.connections.size === 0) {
          this.settle(new Error('No peers are available for this magnet link right now'))
        }
      })
    }).finally(() => {
      this.teardown()
    })
  }

  /**
   * Drops any piece whose part file isn't the size it should be before trusting it.
   *
   * A manifest is persisted separately from the part files it describes, so a crash between
   * the two can leave the manifest claiming a piece the disk doesn't have. Re-downloading a
   * piece costs seconds; assembling a file around a missing one produces silent corruption.
   */
  private async reconcileCompletedPieces(): Promise<void> {
    const checks = this.completed.map(async (done, index) => {
      if (!done) return
      try {
        const { size } = await stat(this.partPath(index))
        if (size === pieceLengthAt(this.options.info, index)) return
      } catch {
        // Missing or unreadable — treat it as never downloaded.
      }
      this.completed[index] = false
      this.options.onPieceReset(index)
    })

    await Promise.all(checks)
    this.remainingPieces = this.completed.filter((done) => !done).length
  }

  private partPath(index: number): string {
    return join(this.options.partsDir, `part-${index}`)
  }

  /** Bytes still needed. Reported to trackers, which hand a peer announcing 0 only the
   * leechers they know — withholding the seeds this download depends on. */
  private remainingBytes(): number {
    let remaining = 0
    for (let index = 0; index < this.pieceCount; index += 1) {
      if (!this.completed[index]) remaining += pieceLengthAt(this.options.info, index)
    }
    return remaining
  }

  private settle(error?: Error): void {
    if (this.settled) return
    this.settled = true
    if (error) this.rejectRun?.(error)
    else this.resolveRun?.()
  }

  private teardown(): void {
    clearInterval(this.announceTimer)
    clearInterval(this.watchdogTimer)
    for (const connection of this.connections.values()) {
      connection.onClose = undefined
      connection.destroy()
    }
    this.connections.clear()
    this.connectedAt.clear()
    this.knownPeers.clear()
    this.peersInHand.clear()
    this.peerRetryAfter.clear()
    this.peerFailures.clear()
    this.poisonedPeers.clear()
    this.peerQueue = []
    this.pieces.clear()
    this.assignments.clear()
    this.slotPiece.clear()
    this.requestedBlocks.clear()
  }

  /**
   * Drops peers that have held a slot without ever unchoking us.
   *
   * Without this a slot can be occupied indefinitely: a choking peer still sends keep-alives,
   * so the socket's stall timeout never fires, and the slot delivers nothing for the life of
   * the download. Cycling it costs one reconnect and buys a chance at a peer that will serve.
   */
  private retireChokedPeers(): void {
    if (this.settled) return
    const now = Date.now()

    for (const [slotId, connection] of this.connections) {
      if (!connection.isChoked) continue
      const since = this.connectedAt.get(slotId)
      if (since === undefined || now - since < CHOKE_PATIENCE_MS) continue
      connection.destroy(new Error('Peer never unchoked'))
    }
  }

  private async refreshPeers(): Promise<void> {
    if (this.settled || this.announceInFlight) return
    // Slots refill on every disconnect, so without a floor a churning swarm would announce
    // continuously and get us rate-limited by the trackers we depend on.
    if (Date.now() - this.lastAnnounceAt < MIN_ANNOUNCE_INTERVAL_MS) return

    this.lastAnnounceAt = Date.now()
    this.announceInFlight = true

    try {
      const peers = await discoverPeers(
        this.options.magnet,
        this.peerId,
        this.options.signal,
        this.remainingBytes()
      )
      if (this.settled) return

      // Re-announces return mostly the same peers, so this is a roster update rather than a
      // list of new work: `requeuePeers` decides what is actually dialable right now.
      for (const peer of peers) {
        this.knownPeers.set(`${peer.host}:${peer.port}`, peer)
      }
      this.forgetOldestPeers()

      this.requeuePeers()
      this.fillSlots()
    } catch {
      // A failed re-announce is survivable: existing peers keep working and the next
      // interval tries again. Only a total lack of peers ends the download, via the
      // watchdog or the initial announce.
    } finally {
      this.announceInFlight = false
    }
  }

  /**
   * Queues every known peer that is neither in hand nor still resting.
   *
   * This is the counterpart to resting peers rather than banning them, and it runs on the
   * watchdog tick as well as after an announce — a network whose peers have all dropped
   * should not have to wait out the announce interval to be given something to dial, and
   * a network coming back off probation needs a queue to come back to.
   */
  private requeuePeers(): void {
    if (this.settled) return
    const now = Date.now()

    for (const [key, peer] of this.knownPeers) {
      if (this.peersInHand.has(key)) continue
      if ((this.peerRetryAfter.get(key) ?? 0) > now) continue

      this.peerRetryAfter.delete(key)
      this.peersInHand.add(key)
      this.peerQueue.push(peer)
    }
  }

  /**
   * Records how a peer's connection ended, so its next dial is timed to match.
   *
   * Nothing here is permanent. A peer is only ever put out of reach for a while, because the
   * alternative — the ban list this replaced — ends with nothing left to dial.
   */
  private notePeerOutcome(key: string, servedBytes: boolean): void {
    if (this.poisonedPeers.delete(key)) {
      this.peerRetryAfter.set(key, Date.now() + PEER_RETRY_CORRUPT_MS)
      return
    }

    if (servedBytes) {
      // It worked once, so whatever ended it is more likely a rotation of its upload slots
      // than a reason to write it off. A proven peer outranks any untried one.
      this.peerFailures.delete(key)
      this.peerRetryAfter.set(key, Date.now() + PEER_RETRY_AFTER_SERVING_MS)
      return
    }

    const failures = (this.peerFailures.get(key) ?? 0) + 1
    this.peerFailures.set(key, failures)
    this.peerRetryAfter.set(
      key,
      Date.now() + Math.min(PEER_RETRY_BASE_MS * 2 ** (failures - 1), PEER_RETRY_MAX_MS)
    )
  }

  /** Trims the roster's oldest entries. Insertion-ordered, so the front is the least recently
   * learned — and a peer worth keeping is re-announced back in within the minute. */
  private forgetOldestPeers(): void {
    if (this.knownPeers.size <= MAX_KNOWN_PEERS) return

    for (const key of this.knownPeers.keys()) {
      if (this.knownPeers.size <= MAX_KNOWN_PEERS) break
      if (this.peersInHand.has(key)) continue
      this.knownPeers.delete(key)
      this.peerRetryAfter.delete(key)
      this.peerFailures.delete(key)
    }
  }

  /**
   * Gives idle slots peers, rotating between networks.
   *
   * Fairness here is the feature, not a nicety. A single pass over `slots` hands peers to
   * whichever network's slots come first, and the peer queue is almost always shorter than
   * the slot count — most of a tracker's list never answers, and a swarm rarely offers 50
   * usable peers per network. So a greedy pass gives one network every peer and leaves the
   * others with nothing to dial, which looks exactly like multi-network downloading not
   * working. Rotating means each network gets a comparable share of whatever the swarm
   * actually provided, however little that is.
   */
  private fillSlots(): void {
    if (this.settled) return

    const freeByInterface = new Map<string, TorrentSlot[]>()
    for (const slot of this.options.slots) {
      if (this.connections.has(slot.id)) continue
      // This slot's network has proved it has no route to the swarm; spending peers on it
      // only starves the slots that do.
      if (this.health.isRetired(slot.interfaceId)) continue

      const free = freeByInterface.get(slot.interfaceId)
      if (free) free.push(slot)
      else freeByInterface.set(slot.interfaceId, [slot])
    }

    const perInterface = [...freeByInterface.values()]
    if (perInterface.length === 0) return

    let rotation = 0
    while (this.peerQueue.length > 0) {
      // Skip networks that have run out of free slots; stop once none are left.
      let slot: TorrentSlot | undefined
      for (let attempt = 0; attempt < perInterface.length; attempt += 1) {
        const candidates = perInterface[(rotation + attempt) % perInterface.length]
        if (candidates.length > 0) {
          slot = candidates.pop()
          rotation += attempt + 1
          break
        }
      }
      if (!slot) return

      const peer = this.peerQueue.shift()
      if (!peer) return

      // Already marked in-hand when it was queued, so no bookkeeping is needed here.
      this.openConnection(slot, peer)
    }
  }

  private openConnection(slot: TorrentSlot, peer: PeerAddress): void {
    const peerKey = `${peer.host}:${peer.port}`
    // Whether this peer gave us anything at all, which is what separates a peer worth coming
    // back to soon from one that only ever held a slot open.
    let servedBytes = false

    const connection = new PeerConnection({
      peer,
      localAddress: slot.localAddress,
      interfaceId: slot.interfaceId,
      infoHash: this.options.magnet.infoHash,
      peerId: this.peerId
    })

    connection.onHavePiece = (index) => {
      // Getting this far proves the network reached a peer, clearing any earlier failures
      // that were really the peers' fault rather than the route's.
      this.health.noteSuccess(slot.interfaceId)
      // A bitfield can carry padding bits past the last real piece.
      if (index < 0 || index >= this.pieceCount) return
      this.availability[index] += 1
      if (this.slotPiece.get(slot.id) === undefined) this.driveSlot(slot.id)
    }

    connection.onReady = () => this.driveSlot(slot.id)

    connection.onBytes = () => {
      servedBytes = true
      this.lastProgressAt = Date.now()
    }

    connection.onPieceBlock = (block) => this.onBlock(slot, block)

    connection.onClose = (error) => {
      this.connections.delete(slot.id)
      this.connectedAt.delete(slot.id)

      this.peersInHand.delete(peerKey)

      if (this.health.noteFailure(slot.interfaceId, error)) {
        // An unroutable network says nothing about the peer: it was never really tried, so
        // it goes straight back to the front for a network that does have a route.
        this.poisonedPeers.delete(peerKey)
        this.peerRetryAfter.delete(peerKey)
        this.peersInHand.add(peerKey)
        this.peerQueue.unshift(peer)
      } else {
        this.notePeerOutcome(peerKey, servedBytes)
      }

      for (const index of connection.availablePieces()) {
        if (index >= 0 && index < this.pieceCount && this.availability[index] > 0) {
          this.availability[index] -= 1
        }
      }
      this.releaseSlot(slot.id)
      this.options.onSlotChanged(slot.id, { connected: false, pieceIndex: null, peer: null })

      if (this.settled) return
      if (this.peerQueue.length > 0) this.fillSlots()
      else void this.refreshPeers()
    }

    this.connections.set(slot.id, connection)
    this.connectedAt.set(slot.id, Date.now())
    this.options.onSlotChanged(slot.id, {
      connected: true,
      pieceIndex: null,
      peer: `${peer.host}:${peer.port}`
    })
    connection.connect()
  }

  /** Detaches a slot from its piece, leaving the piece's buffered bytes in place so another
   * slot can carry on from where this one stopped. */
  private releaseSlot(slotId: number): void {
    const pieceIndex = this.slotPiece.get(slotId)
    if (pieceIndex !== undefined) {
      this.assignments.get(pieceIndex)?.delete(slotId)
      this.slotPiece.delete(slotId)
    }
    this.requestedBlocks.delete(slotId)
    this.prunePieceBuffers()
  }

  /**
   * Caps how many half-finished pieces are held in memory.
   *
   * A piece stays buffered until it passes its hash, and a peer that dies mid-piece leaves
   * its buffer behind for another slot to finish. That is usually what we want — those bytes
   * are worth keeping — but on a churning swarm the orphans accumulate, and the ceiling is
   * the entire torrent resident in RAM. Past the cap the least-complete orphans are dropped,
   * since they are the cheapest to fetch again and nobody is working on them.
   */
  private prunePieceBuffers(): void {
    const limit = Math.max(this.options.slots.length * 2, 8)
    if (this.pieces.size <= limit) return

    const orphans = [...this.pieces.entries()].filter(
      ([index, piece]) => !piece.finalizing && (this.assignments.get(index)?.size ?? 0) === 0
    )
    // Most blocks still missing first — the least progress to throw away.
    orphans.sort((a, b) => b[1].remainingBlocks - a[1].remainingBlocks)

    for (const [index] of orphans) {
      if (this.pieces.size <= limit) break
      this.pieces.delete(index)
      this.options.onPieceReset(index)
    }
  }

  /**
   * Chooses the next piece for a slot, rarest first.
   *
   * Preferring rare pieces keeps the swarm's scarce data from disappearing when its only
   * seed leaves, which is also what keeps a download from stalling at 99%. Pieces already
   * assigned elsewhere are skipped until nothing else is left — at which point duplicating
   * them (endgame) is what stops one slow peer from holding up the whole torrent.
   */
  private pickPiece(slotId: number): number | null {
    const connection = this.connections.get(slotId)
    if (!connection) return null

    let best: number | null = null
    let bestAvailability = Number.POSITIVE_INFINITY
    let bestAssigned = Number.POSITIVE_INFINITY

    for (let index = 0; index < this.pieceCount; index += 1) {
      if (this.completed[index]) continue
      if (!connection.hasPiece(index)) continue

      const assigned = this.assignments.get(index)?.size ?? 0
      const availability = this.availability[index]

      // Unassigned pieces always win; among equals, the rarest.
      if (
        assigned < bestAssigned ||
        (assigned === bestAssigned && availability < bestAvailability)
      ) {
        best = index
        bestAssigned = assigned
        bestAvailability = availability
      }
    }

    return best
  }

  /** Keeps a slot's request pipeline full, picking a new piece when its current one is done. */
  private driveSlot(slotId: number): void {
    if (this.settled) return

    const connection = this.connections.get(slotId)
    if (!connection || !connection.isConnected || connection.isChoked) return

    let pieceIndex = this.slotPiece.get(slotId)

    if (pieceIndex === undefined || this.completed[pieceIndex]) {
      if (pieceIndex !== undefined) this.releaseSlot(slotId)

      const picked = this.pickPiece(slotId)
      if (picked === null) return

      pieceIndex = picked
      this.slotPiece.set(slotId, pieceIndex)
      this.requestedBlocks.set(slotId, new Set())

      let assigned = this.assignments.get(pieceIndex)
      if (!assigned) {
        assigned = new Set()
        this.assignments.set(pieceIndex, assigned)
      }
      assigned.add(slotId)

      this.options.onSlotChanged(slotId, {
        connected: true,
        pieceIndex,
        peer: `${connection.peer.host}:${connection.peer.port}`
      })
    }

    const piece = this.ensurePieceBuffer(pieceIndex)
    const requested = this.requestedBlocks.get(slotId)
    if (!requested) return

    // With nothing in flight, anything this slot asked for is never arriving: a peer
    // discards its whole queue when it chokes us. Forgetting those requests is what lets
    // them be re-asked — otherwise the slot waits forever on a queue that no longer exists
    // and quietly stops contributing for the rest of the download.
    if (connection.inFlight === 0) requested.clear()

    const pieceBytes = pieceLengthAt(this.options.info, pieceIndex)

    for (let blockIndex = 0; blockIndex < piece.receivedBlocks.length; blockIndex += 1) {
      if (connection.inFlight >= PIPELINE_DEPTH) break

      const begin = blockIndex * BLOCK_BYTES
      if (piece.receivedBlocks[blockIndex] || requested.has(begin)) continue

      requested.add(begin)
      connection.requestBlock(pieceIndex, begin, Math.min(BLOCK_BYTES, pieceBytes - begin))
    }
  }

  private ensurePieceBuffer(pieceIndex: number): PieceBuffer {
    const existing = this.pieces.get(pieceIndex)
    if (existing) return existing

    const pieceBytes = pieceLengthAt(this.options.info, pieceIndex)
    const blockCount = Math.ceil(pieceBytes / BLOCK_BYTES)
    const piece: PieceBuffer = {
      data: Buffer.alloc(pieceBytes),
      receivedBlocks: new Array<boolean>(blockCount).fill(false),
      remainingBlocks: blockCount,
      contributors: new Set(),
      finalizing: false
    }
    this.pieces.set(pieceIndex, piece)
    return piece
  }

  private onBlock(slot: TorrentSlot, block: PieceBlock): void {
    if (this.settled) return
    if (block.index < 0 || block.index >= this.pieceCount) return
    if (this.completed[block.index]) return

    const piece = this.pieces.get(block.index)
    if (!piece || piece.finalizing) return

    // Every field here came off the wire, and each is used as an offset into a fixed-size
    // buffer, so all three have to be checked before the copy rather than trusted.
    if (block.begin % BLOCK_BYTES !== 0) return
    const blockIndex = block.begin / BLOCK_BYTES
    if (blockIndex < 0 || blockIndex >= piece.receivedBlocks.length) return

    const expectedBytes = Math.min(BLOCK_BYTES, piece.data.length - block.begin)
    if (block.data.length !== expectedBytes) return

    // A duplicate is expected in endgame, where several slots race the same piece.
    if (piece.receivedBlocks[blockIndex]) {
      this.driveSlot(slot.id)
      return
    }

    block.data.copy(piece.data, block.begin)
    piece.receivedBlocks[blockIndex] = true
    piece.remainingBlocks -= 1
    piece.contributors.add(slot.id)

    this.lastProgressAt = Date.now()
    this.options.onProgress(slot.id, block.index, block.data.length)

    if (piece.remainingBlocks > 0) {
      this.driveSlot(slot.id)
      return
    }

    piece.finalizing = true
    void this.finalizePiece(block.index, piece)
  }

  /**
   * Verifies a fully received piece and writes it out, or throws it away.
   *
   * This is the guarantee the HTTP engine can't make: a piece's SHA-1 is published in the
   * metadata, whose own hash is the magnet link, so bad bytes are provably bad and are
   * discarded before anything reaches the disk. A failure costs one piece, not the file.
   */
  private async finalizePiece(pieceIndex: number, piece: PieceBuffer): Promise<void> {
    const expectedHash = this.options.info.pieceHashes[pieceIndex]
    const actualHash = createHash('sha1').update(piece.data).digest()

    if (!actualHash.equals(expectedHash)) {
      this.pieces.delete(pieceIndex)
      this.assignments.delete(pieceIndex)
      this.options.onPieceReset(pieceIndex)

      // One of the contributing peers sent corrupt data and there is no way to tell which,
      // so all of them lose their slot. Dropping a peer costs a reconnect; keeping a
      // corrupting one costs this piece again on every retry.
      for (const slotId of piece.contributors) {
        this.releaseSlot(slotId)
        const connection = this.connections.get(slotId)
        if (!connection) continue
        // Marked before the destroy, because `destroy` calls back into `onClose` synchronously
        // and that is where a peer's next dial gets scheduled. Without this the peer looks
        // like one that served bytes — which it did — and would be back within 30 seconds to
        // cost us the same piece again.
        this.poisonedPeers.add(`${connection.peer.host}:${connection.peer.port}`)
        connection.destroy(new Error('Peer sent data failing its piece hash'))
      }
      return
    }

    try {
      await writeFile(this.partPath(pieceIndex), piece.data)
    } catch (error) {
      // Can't persist it, so it isn't done. Reset and let it be fetched again.
      this.pieces.delete(pieceIndex)
      this.assignments.delete(pieceIndex)
      this.options.onPieceReset(pieceIndex)
      this.settle(error instanceof Error ? error : new Error(String(error)))
      return
    }

    this.completed[pieceIndex] = true
    this.remainingPieces -= 1
    this.pieces.delete(pieceIndex)

    const contributors = [...(this.assignments.get(pieceIndex) ?? [])]
    this.assignments.delete(pieceIndex)
    for (const slotId of contributors) {
      this.slotPiece.delete(slotId)
      this.requestedBlocks.delete(slotId)
    }

    this.options.onPieceComplete(pieceIndex)

    if (this.remainingPieces === 0) {
      this.settle()
      return
    }

    // Every slot gets a nudge, not just the contributors: a slot that found nothing to do
    // earlier may now be able to pick up a piece that was assigned elsewhere.
    for (const slot of this.options.slots) this.driveSlot(slot.id)
  }
}
