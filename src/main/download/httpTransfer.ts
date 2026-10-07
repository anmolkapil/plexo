import type {
  HttpBlockState,
  HttpStreamState,
  DownloadNetwork,
  DownloadStatus,
  NetworkStatus,
  StartHttpDownloadRequest
} from '../../shared/types'
import { testKnobs, testStreamsPerNetwork } from '../testKnobs'
import { advanceBlock, retractBlock } from './blockProgress'
import { ConcurrencyController, type Action, type Snapshot } from './concurrency'
import { downloadChunk, fetchRange, HttpStatusError, RemoteChangedError } from './chunkDownloader'
import { compareVersion, type FileVersion } from './fileVersion'
import { interleave, MAX_STREAMS_PER_NETWORK, startingStreams } from './plan'
import { pickWork, type SchedulerPolicy, type Work } from './scheduler'
import {
  delay,
  recomputeAggregates,
  type Transfer,
  type TransferHost,
  type HttpTransferTarget
} from './transfer'
import { ConnectionError, NoCompatibleRouteError, StreamConnection } from '../network/routes'

/** Why an attempt was called off by the manager rather than by a pause or a failure. */
type AbortReason = 'refresh' | 'lost'

/**
 * One request for one block, by one stream. A block normally has a single (primary) attempt.
 * Near the end of a download a second (hedge) one may race it — see scheduler.ts — and then the
 * block is finished by whichever gets there first.
 *
 * Both write straight into the staging file at the block's own offsets. Every response is checked
 * to be the download's version before any of it is written, so racing attempts write identical
 * bytes and it doesn't matter which lands last: whatever either has written stays secured.
 */
interface Attempt {
  kind: 'primary' | 'hedge'
  block: HttpBlockState
  streamId: number
  networkId: string
  /** Where the request begins, as an offset into the block. Null until it is known. */
  startOffset: number | null
  /** Bytes the destination writer has accepted; safe to resume from this prefix. */
  received: number
  /** Bytes the network has delivered, independently of disk backpressure. */
  networkReceived: number
  lastNetworkAt: number
  writeWaiting: boolean
  /** When the request was sent. */
  startedAt: number
  /** The network previously credited for this block's prefix. */
  previousWriter: string | undefined
  /** Aborts this request alone; ChunkRuntime.controller aborts the whole stream. */
  abort: AbortController
  abortReason: AbortReason | null
  /** What the server's answer cost, for diagnosing slow connections (see PLEXO_DEBUG). */
  response: { ttfbMs: number; reusedSocket: boolean } | null
}

/** What became of an attempt's request. */
type AttemptOutcome =
  | { type: 'completed' }
  /** The download was paused or cancelled underneath it. */
  | { type: 'stopped' }
  /** Called off by the manager (see AbortReason). */
  | { type: 'aborted'; reason: AbortReason }
  | { type: 'failed'; error: unknown }

interface ChunkRuntime {
  /** Aborts the whole stream: pause and cancel. */
  controller: AbortController
  /** Cuts its waits short — a backoff, a look for work — when the stream stops, or when the run
   * has nothing left for it to do. */
  wait: AbortSignal
  /** Cuts a backoff short without stopping the stream: what it was waiting out has changed (see
   * wake). Replaced once used. */
  nudge: AbortController
  /** Its one connection to the server, reused from block to block. */
  connection: StreamConnection
  /** What the stream is fetching right now, if anything. */
  attempt: Attempt | null
  /** When this connection last (re)connected; it isn't judged until SLOW_WARMUP_MS after. */
  warmSince: number
  slowSince: number | null
  /** Speed of its last finished block, start to end — 0 until it finishes one. */
  lastBlockSpeed: number
  /** Everything it has received, bytes another attempt already had included: what its speed is
   * measured from. (`HttpStreamState.bytesDownloaded` counts only bytes that were new.) */
  receivedBytes: number
  /** Failed attempts in a row, for backoff. */
  failures: number
  /** Of those, the ones the server answered wrongly: MAX_CHUNK_RETRIES of them and it gives up.
   * A connection that failed isn't one — see finishFailed. */
  strikes: number
  /** When the server first answered busy (see HttpStatusError.transient) since this stream last
   * made progress: a busy server is waited out for SERVER_BUSY_FOR_MS, not MAX_CHUNK_RETRIES. */
  busySince: number | null
  /** Since the stream count last looked: whether the server turned one of its requests away
   * (403, 429, 503, or left it unanswered), and whether it received anything. What a connection
   * limit is judged by (see concurrency.ts). */
  refused: boolean
  served: boolean
  /** Whether any of its writes landed since the last tick. */
  wrote: boolean
  /** Stopped for good, and to leave the list once its worker has (see retireStreams). */
  retiring: boolean
}

// Set PLEXO_DEBUG=1 to log every request's outcome, how long the server took to answer and
// whether it reused a warm connection — what it takes to tell one slow connection from a slow path.
const debug: (...args: unknown[]) => void = process.env['PLEXO_DEBUG']
  ? (...args) => console.debug('[plexo]', ...args)
  : () => {}

const MAX_CHUNK_RETRIES = 5
const RETRY_BASE_DELAY_MS = testKnobs.retryBaseDelayMs
const RETRY_MAX_DELAY_MS = 15_000
// A network that can't reach the server keeps one stream asking (see reconcile). That is one
// cheap connection, so it asks often enough to find out soon after the network gets through.
const UNREACHABLE_RETRY_MS = 5_000
// A server that answers busy (429, 503, …) is waited out this long before a stream gives up on
// it, however many retries that takes; what it asks for in Retry-After is waited, up to
// RETRY_AFTER_MAX_MS.
const SERVER_BUSY_FOR_MS = testKnobs.serverBusyForMs
const RETRY_AFTER_MAX_MS = 120_000

/** Doubling from RETRY_BASE_DELAY_MS, with ±20% jitter as gRPC's backoff has: a network that
 * drops fails all its streams at once, and they shouldn't all come back at the same instant. */
function retryDelayMs(attempt: number): number {
  const exact = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  return exact * (0.8 + 0.4 * Math.random())
}

// A single TCP stream can get stuck at a crawl (loss-collapsed congestion window, a bad CDN node
// or route) while its siblings on the same network run fine. It never goes silent, so the stall
// watchdog can't catch it; a fresh connection usually lands somewhere healthy. Only relative
// thresholds — nothing here knows how fast the network ought to be.
const SLOW_RATIO = 0.1
const SLOW_WARMUP_MS = testKnobs.slowWarmupMs
const SLOW_FOR_MS = testKnobs.slowForMs
// A connection that has received nothing this long, while the file is being served to others, is
// dead rather than slow (a network that isn't answering, a stuck handshake). A whole network
// that has received nothing this long, while its connections fail, can't reach the server.
const SILENT_AFTER_MS = testKnobs.silentAfterMs
// Bounds every case where refreshing can't help (the whole network got slower, a stale
// reference): at worst a block pays for a couple of cheap reconnects, then is left alone.
const MAX_REFRESHES_PER_BLOCK = 2
const SCHEDULER_POLICY: SchedulerPolicy = {
  hedgeAfterMs: testKnobs.hedgeAfterMs,
  maxHedgesPerBlock: 2,
  startupMs: 1000
}

/** Whether the file can be fetched in parts. Otherwise one request has to carry all of it: one
 * stream, on one network. */
export function splittable(request: StartHttpDownloadRequest): boolean {
  return request.supportsRanges && request.totalBytes > 0
}

/** How many streams a download runs is only for it to work out when there can be more than one,
 * and unless a test fixes it. */
function concurrencyFor(request: StartHttpDownloadRequest): ConcurrencyController | null {
  if (!splittable(request) || testStreamsPerNetwork() !== null) return null
  const picked = pickedStreams(request)
  return picked === undefined
    ? new ConcurrencyController(MAX_STREAMS_PER_NETWORK)
    : new ConcurrencyController(picked, false)
}

/** The streams per network the user picked for this download, if they didn't leave it on Auto. */
export function pickedStreams(request: StartHttpDownloadRequest): number | undefined {
  const picked = request.streamsPerNetwork
  return Number.isInteger(picked) && picked! >= 1 && picked! <= MAX_STREAMS_PER_NETWORK
    ? picked
    : undefined
}
/** How often a stream with nothing to do looks for work again. */
const IDLE_POLL_MS = 250
// Just longer than an idle stream takes to look for work, so a refreshed block goes to a
// connection that is already proven fast, if there is one.
const REFRESH_HANDOFF_MS = IDLE_POLL_MS + 50

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function newStream(id: number, networkId: string): HttpStreamState {
  return {
    id,
    interfaceId: networkId,
    rangeStart: 0,
    rangeEnd: null,
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    status: 'pending'
  }
}

function requestedVersion(request: StartHttpDownloadRequest): FileVersion {
  return { etag: request.etag, lastModified: request.lastModified, totalBytes: request.totalBytes }
}

// How much of the already-downloaded file to re-fetch and compare when a server labels a
// response with an ETag or Last-Modified this download hasn't seen before.
const SAMPLE_BYTES = 16 * 1024
const MAX_SAMPLES = 8
/** A sample must come from a server presenting the new label; behind a load balancer the next
 * request may land on another one, so take a few tries at reaching it. */
const SAMPLE_TRIES = 4

/**
 * Fetches a download over HTTP: streams, each one connection to the server through one network,
 * taking blocks from the scheduler and writing them into the staging file at their own offsets.
 */
export class HttpTransfer implements Transfer {
  private chunkRuntimes = new Map<number, ChunkRuntime>()
  /** The running streams' workers, by stream id. Empty unless the download is running. */
  private workers = new Map<number, Promise<void>>()
  /** Each network's status as reconcile last left it; how it tells a network that has just come
   * into use. Cleared at the start of each run. */
  private reconciled = new Map<string, NetworkStatus>()
  /** The version this download started on, plus any since confirmed to serve identical bytes
   * (see confirmSameBytes). Not persisted: after a restart, a confirmation is simply redone. */
  private acceptedVersions: FileVersion[]
  /** Slow-connection refreshes per block index, capped at MAX_REFRESHES_PER_BLOCK. */
  private refreshesByBlock = new Map<number, number>()
  /** For a block whose last attempt delivered nothing, the network that made it. That network
   * leaves the block to another one while another is free to take it (see scheduler.ts). Not
   * persisted: it only steers the next hand-out. */
  private avoidNetworkByBlock = new Map<number, string>()
  /** Attempts in flight, by block index. */
  private attempts = new Map<number, Attempt[]>()
  /** Hedges started per block index, capped at SCHEDULER_POLICY.maxHedgesPerBlock. */
  private hedgesByBlock = new Map<number, number>()
  /** By network id: everything its streams have received, and when it last showed it was alive —
   * received something, or came into use. */
  private traffic = new Map<string, { received: number; aliveAt: number }>()
  /** By network id: until when the server asked (Retry-After) not to be sent new requests over
   * it. */
  private holdUntil = new Map<string, number>()
  /** Decides how many streams each network runs; kept for the whole download, so a pause and
   * resume doesn't forget what it has found out. */
  private concurrency: ConcurrencyController | null

  constructor(
    private readonly runtime: HttpTransferTarget,
    private readonly host: TransferHost
  ) {
    this.acceptedVersions = [requestedVersion(runtime.requestPayload)]
    this.concurrency = concurrencyFor(runtime.requestPayload)
  }

  /**
   * Each network's streams in line with what it can do now:
   * - A network that has just come into use (on) starts a set of them (see startingStreams);
   *   from there concurrency.ts sizes it.
   * - One that can't reach the server (unreachable) keeps a single stream trying, to find out
   *   when it can again.
   * - One that is off, offline or failed runs none. Retiring a stream costs nothing: what it
   *   wrote stays, and whoever takes its block next resumes from there.
   * A download that can't be split runs one stream, on the first network able to carry it.
   */
  reconcile(): void {
    const { state } = this.runtime
    const canSplit = splittable(this.runtime.requestPayload)
    const usable = state.networks.filter(
      (network) => network.status === 'on' || network.status === 'unreachable'
    )
    const running = canSplit ? usable : usable.slice(0, 1)
    const joining = running.filter(
      (network) =>
        network.status === 'on' &&
        (this.reconciled.get(network.id) !== 'on' || this.liveStreams(network.id).length === 0)
    )
    const starting = canSplit
      ? startingStreams(
          this.runtime.blocks.filter((block) => block.status === 'pending').length,
          joining.length,
          testStreamsPerNetwork() ?? pickedStreams(this.runtime.requestPayload)
        )
      : 1

    const now = Date.now()
    const toStart: HttpStreamState[] = []
    for (const network of state.networks) {
      const live = this.liveStreams(network.id)
      const target = !running.includes(network)
        ? 0
        : network.status === 'unreachable'
          ? 1
          : joining.includes(network)
            ? Math.max(live.length, starting)
            : live.length
      if (joining.includes(network)) this.trafficOf(network.id).aliveAt = now
      if (live.length > target) this.retireStreams(network.id, live.length - target)
      // Streams kept from before a pause start again.
      for (const chunk of live.slice(0, target)) {
        if (!this.workers.has(chunk.id)) toStart.push(chunk)
      }
      if (target > live.length) {
        toStart.push(...this.addStreams(network.id, target - live.length))
      }
      this.reconciled.set(network.id, network.status)
    }
    // Each stream claims a block the moment it starts, so every network gets its first before
    // any gets a second: a small file shouldn't all go to whichever network came first.
    this.startStreams(interleave(toStart, (chunk) => chunk.interfaceId))
  }

  tick(now: number): void {
    this.refreshStuckConnections(now)
    this.host.reconcile()
    this.adjustStreams(this.concurrency?.tick(this.concurrencySnapshot()))
    // Each refusal is counted once.
    for (const self of this.chunkRuntimes.values()) {
      self.refused = false
      self.served = false
      self.wrote = false
    }
  }

  running(): Iterable<Promise<void>> {
    return this.workers.values()
  }

  abort(): void {
    for (const self of this.chunkRuntimes.values()) self.controller.abort()
  }

  reset(): void {
    this.avoidNetworkByBlock.clear()
    this.reconciled.clear()
  }

  systemResumed(now: number): void {
    for (const traffic of this.traffic.values()) traffic.aliveAt = now
    for (const self of this.chunkRuntimes.values()) {
      self.warmSince = now
      self.slowSince = null
    }
    this.wake(
      () => true,
      () => true
    )
  }

  /**
   * Gets streams going again now, rather than when their backoff runs out: what held them back
   * has changed. The ones `reconnect` picks also drop their sockets, and what they were fetching
   * is taken up again on a new one: a refresh, so nothing is lost and no retry is counted.
   */
  wake(pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void {
    for (const chunk of this.runtime.state.streams) {
      const self = this.chunkRuntimes.get(chunk.id)
      if (!self || self.retiring || !pick(chunk.interfaceId)) continue
      self.failures = 0
      if (reconnect(chunk.interfaceId)) {
        if (self.attempt) this.abortAttempt(self.attempt, 'refresh')
        self.connection.reconnect()
      }
      self.nudge.abort()
    }
  }

  /** Waits out a backoff; cut short when the stream stops, or is woken (see wake). */
  private async backOff(self: ChunkRuntime, ms: number): Promise<void> {
    await delay(ms, AbortSignal.any([self.wait, self.nudge.signal]))
    if (self.nudge.signal.aborted) self.nudge = new AbortController()
  }

  private network(id: string): DownloadNetwork {
    const network = this.runtime.state.networks.find((entry) => entry.id === id)
    if (!network) throw new Error(`Unknown network ${id}`)
    return network
  }

  /** A network's streams that aren't on their way out. */
  private liveStreams(networkId: string): HttpStreamState[] {
    return this.runtime.state.streams.filter(
      (chunk) => chunk.interfaceId === networkId && !this.chunkRuntimes.get(chunk.id)?.retiring
    )
  }

  private trafficOf(networkId: string): { received: number; aliveAt: number } {
    let traffic = this.traffic.get(networkId)
    if (!traffic) this.traffic.set(networkId, (traffic = { received: 0, aliveAt: 0 }))
    return traffic
  }

  private startStreams(chunks: HttpStreamState[]): void {
    for (const chunk of chunks) {
      this.workers.set(
        chunk.id,
        this.runWorker(chunk).finally(() => {
          this.workers.delete(chunk.id)
          if (this.chunkRuntimes.get(chunk.id)?.retiring) this.removeStream(chunk)
        })
      )
    }
    if (chunks.length > 0) this.host.scheduleUpdate()
  }

  private adjustStreams(actions: Action[] | undefined): void {
    for (const action of actions ?? []) {
      if (action.kind === 'add') {
        this.startStreams(this.addStreams(action.networkId, action.count))
      } else {
        this.retireStreams(action.networkId, action.count)
      }
    }
  }

  /**
   * Reconnects a connection that isn't carrying its weight. Reconnecting is cheap — the block
   * resumes from the staging file — and a fresh connection usually lands somewhere healthy.
   *
   * - Silent: nothing received for SILENT_AFTER_MS while the file is demonstrably being served
   *   to others. Judged by the clock alone, so it also catches a network that has yet to
   *   deliver a byte and therefore has no speed to be compared with.
   * - Crawling: under SLOW_RATIO of its network's reference speed for SLOW_FOR_MS. The reference
   *   is the median of what connections on the same network are doing now and did on their last
   *   finished block — its own included, which covers the tail (everyone else is done) and a
   *   network with a single connection. Networks are never compared with each other: cellular
   *   is expected to be slower than Wi-Fi.
   *
   * Reconnecting only swaps one connection for another, and stops after a couple of tries; what
   * can finish a block whose connections all crawl is a hedge (see scheduler.ts).
   */
  private refreshStuckConnections(now: number): void {
    // Without ranges a reconnect restarts the whole file from byte 0.
    if (!this.runtime.requestPayload.supportsRanges) return

    let unreachable = false
    for (const chunk of this.runtime.state.streams) {
      const self = this.chunkRuntimes.get(chunk.id)
      const attempt = self?.attempt
      if (!self || !attempt || attempt.abortReason) continue

      // A paused reader or final flush says nothing about the connection's health.
      if (attempt.writeWaiting) {
        self.slowSince = null
        continue
      }
      const silent = this.isSilent(attempt, now)
      // A refresh isn't a failure, so no failed request would say that the network can't get
      // through; a connection gone silent with the rest of its network says it instead, as soon
      // as SILENT_AFTER_MS rather than once a connect or stall timeout has run out.
      if (silent && this.markUnreachable(this.network(attempt.networkId), now)) {
        unreachable = true
      }
      // Silent while its network's other connections are served: the server took the connection
      // and left it waiting, which is how some turn away one too many (see concurrency.ts).
      if (silent) self.refused = true

      const index = attempt.block.index
      const refreshes = this.refreshesByBlock.get(index) ?? 0
      // A hedge is optional work: it is only ever dropped, never counted against its block.
      const isPrimary = attempt.kind === 'primary'
      if (isPrimary && refreshes >= MAX_REFRESHES_PER_BLOCK) continue

      if (silent || (isPrimary && this.isCrawling(chunk, self, now))) {
        if (isPrimary) this.refreshesByBlock.set(index, refreshes + 1)
        this.abortAttempt(attempt, 'refresh')
      }
    }
    if (unreachable) this.host.reconcile()
  }

  /** Marks a network in use that has received nothing for SILENT_AFTER_MS as unable to reach the
   * server. Whether it did. */
  private markUnreachable(network: DownloadNetwork, now: number): boolean {
    if (network.status !== 'on') return false
    if (now - this.trafficOf(network.id).aliveAt < SILENT_AFTER_MS) return false
    network.status = 'unreachable'
    return true
  }

  private isSilent(attempt: Attempt, now: number): boolean {
    if (attempt.networkReceived > 0 || now - attempt.startedAt < SILENT_AFTER_MS) return false
    // Until something has arrived, a quiet origin is just a slow one — nothing to blame this
    // connection for.
    return this.runtime.blocks.some(
      (block) => block.index !== attempt.block.index && block.bytesDownloaded > 0
    )
  }

  private isCrawling(chunk: HttpStreamState, self: ChunkRuntime, now: number): boolean {
    const warm = (connection: ChunkRuntime): boolean => now - connection.warmSince >= SLOW_WARMUP_MS
    if (!warm(self)) return false

    const reference: number[] = []
    for (const other of this.runtime.state.streams) {
      if (other.interfaceId !== chunk.interfaceId) continue
      const peer = this.chunkRuntimes.get(other.id)
      if (!peer) continue
      if (peer.lastBlockSpeed > 0) reference.push(peer.lastBlockSpeed)
      if (other !== chunk && peer.attempt && warm(peer)) reference.push(other.speedBytesPerSec)
    }

    if (reference.length === 0 || chunk.speedBytesPerSec >= median(reference) * SLOW_RATIO) {
      self.slowSince = null
      return false
    }
    self.slowSince ??= now
    return now - self.slowSince >= SLOW_FOR_MS
  }

  private abortAttempt(attempt: Attempt, reason: AbortReason): void {
    if (attempt.abortReason) return
    attempt.abortReason = reason
    attempt.abort.abort()
  }

  // --- attempts ---------------------------------------------------------------------------------
  //
  // A stream's life is a loop: ask the scheduler for work, run it as an attempt, then apply what
  // became of it. Everything that changes the download's state happens in the synchronous stretches
  // between awaits, so a stream never sees another's half-finished change.

  /** Where an attempt has got to in its block. */
  private attemptPosition(attempt: Attempt): number {
    return (attempt.startOffset ?? 0) + attempt.received
  }

  /** How far the block's other attempts have got: what is safe to keep counted when one lets go. */
  private otherAttemptsPosition(attempt: Attempt): number {
    let furthest = 0
    for (const other of this.attempts.get(attempt.block.index) ?? []) {
      if (other !== attempt) furthest = Math.max(furthest, this.attemptPosition(other))
    }
    return furthest
  }

  /** The stream holds no block: it says so, rather than keeping the last one's numbers on show. */
  private goIdle(chunk: HttpStreamState): void {
    chunk.status = 'pending'
    chunk.currentBlockIndex = undefined
    chunk.hedge = undefined
    chunk.speedBytesPerSec = 0
  }

  private beginAttempt(chunk: HttpStreamState, self: ChunkRuntime, work: Work): Attempt {
    const { block } = work
    const attempt: Attempt = {
      kind: work.kind,
      block,
      streamId: chunk.id,
      networkId: chunk.interfaceId,
      startOffset: null,
      received: 0,
      networkReceived: 0,
      lastNetworkAt: 0,
      writeWaiting: false,
      startedAt: Date.now(),
      // Whoever held this block before now is the one whose tail bytes a truncation would
      // discard — captured before the lease overwrites the field.
      previousWriter: block.interfaceId,
      abort: new AbortController(),
      abortReason: null,
      response: null
    }

    if (work.kind === 'primary') {
      block.status = 'downloading'
      block.interfaceId = chunk.interfaceId
      this.avoidNetworkByBlock.delete(block.index)
    } else {
      this.hedgesByBlock.set(block.index, (this.hedgesByBlock.get(block.index) ?? 0) + 1)
    }
    const inFlight = this.attempts.get(block.index)
    if (inFlight) inFlight.push(attempt)
    else this.attempts.set(block.index, [attempt])
    self.attempt = attempt

    chunk.status = 'downloading'
    chunk.hedge = work.kind === 'hedge' ? true : undefined
    chunk.rangeStart = block.rangeStart
    chunk.rangeEnd = block.rangeEnd
    chunk.currentBlockIndex = block.index
    return attempt
  }

  /** Takes the attempt off the books. Safe to repeat. */
  private endAttempt(self: ChunkRuntime, attempt: Attempt): void {
    const inFlight = this.attempts.get(attempt.block.index)
    if (inFlight) {
      const position = inFlight.indexOf(attempt)
      if (position >= 0) inFlight.splice(position, 1)
      if (inFlight.length === 0) this.attempts.delete(attempt.block.index)
    }
    if (self.attempt === attempt) self.attempt = null
  }

  /** Sends the request and reports how it ended. Never throws. */
  private async executeAttempt(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt
  ): Promise<AttemptOutcome> {
    const { block } = attempt
    try {
      if (attempt.kind === 'primary') {
        // A failed range leaves its written prefix in the staging file. Without range support,
        // the server can only restart from byte zero.
        attempt.startOffset = this.runtime.requestPayload.supportsRanges ? block.bytesDownloaded : 0
        // What another attempt has already secured stays counted.
        const keep = Math.max(attempt.startOffset, this.otherAttemptsPosition(attempt))
        if (retractBlock(block, keep, attempt.previousWriter) > 0) {
          recomputeAggregates(this.runtime.state, this.runtime.blocks)
        }
      } else {
        attempt.startOffset = block.bytesDownloaded
      }

      const length = block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1
      if (length !== null && attempt.startOffset >= length) {
        // The staging file already holds the whole block.
        return attempt.kind === 'primary'
          ? { type: 'completed' }
          : { type: 'aborted', reason: 'lost' }
      }

      attempt.startedAt = Date.now()
      await downloadChunk({
        url: this.runtime.requestPayload.url,
        rangeStart: block.rangeStart + attempt.startOffset,
        rangeEnd: block.rangeEnd,
        connection: self.connection,
        createDestination: () =>
          this.runtime.file.writer(block.rangeStart + (attempt.startOffset ?? 0)),
        signal: AbortSignal.any([self.controller.signal, attempt.abort.signal]),
        acceptedVersions: this.acceptedVersions,
        onResponse: (info) => (attempt.response = info),
        throttle: (bytes) => this.host.limits.take(attempt.networkId, bytes),
        onWriteWait: (waiting) => (attempt.writeWaiting = waiting),
        onNetworkProgress: (bytesThisRun) => {
          const delta = bytesThisRun - attempt.networkReceived
          if (delta > 0) {
            attempt.networkReceived = bytesThisRun
            attempt.lastNetworkAt = Date.now()
            this.onNetworkProgress(chunk, self, delta)
          }
        },
        onProgress: (bytesThisRun) => {
          const delta = bytesThisRun - attempt.received
          if (delta > 0) {
            attempt.received = bytesThisRun
            self.wrote = true
            this.onAttemptProgress(chunk, attempt)
          }
        }
      })
      return { type: 'completed' }
    } catch (error) {
      const status = this.runtime.state.status as DownloadStatus
      if (self.controller.signal.aborted || status !== 'downloading') return { type: 'stopped' }
      if (attempt.abortReason) return { type: 'aborted', reason: attempt.abortReason }
      return { type: 'failed', error }
    }
  }

  private onNetworkProgress(chunk: HttpStreamState, self: ChunkRuntime, deltaBytes: number): void {
    const now = Date.now()
    self.receivedBytes += deltaBytes
    self.served = true
    const traffic = this.trafficOf(chunk.interfaceId)
    traffic.received += deltaBytes
    traffic.aliveAt = now
    const network = this.network(chunk.interfaceId)
    if (network.status === 'unreachable') {
      // Through again: the next reconcile gives it back its streams.
      network.status = 'on'
      self.failures = 0
    }
    // Read as speeds on the download's clock (see updateSpeeds).
    this.runtime.meters.add(chunk.id, chunk.interfaceId, deltaBytes)
    this.host.scheduleUpdate()
  }

  private onAttemptProgress(chunk: HttpStreamState, attempt: Attempt): void {
    // Only what gets the block further than it already was counts as progress: a racing attempt
    // re-fetches bytes the other already has.
    const gained = advanceBlock(attempt.block, attempt.networkId, this.attemptPosition(attempt))
    chunk.bytesDownloaded += gained
    this.network(attempt.networkId).bytesDownloaded += gained

    // This runs on every completed writer callback, so it folds the delta in rather than re-summing
    // every block — that sum is O(blocks), and a large file has thousands of them. The other
    // callers of recomputeAggregates are rare enough to afford the full pass, and each one
    // re-derives the true total, so any drift here cannot accumulate.
    this.runtime.state.bytesDownloaded += gained
    this.host.scheduleUpdate()
  }

  /** Applies what became of an attempt to the download. 'stop' ends the stream. */
  private async finishAttempt(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt,
    outcome: AttemptOutcome
  ): Promise<'continue' | 'stop'> {
    debug('attempt', {
      block: attempt.block.index,
      stream: chunk.id,
      network: attempt.networkId,
      kind: attempt.kind,
      outcome: outcome.type === 'aborted' ? `aborted:${outcome.reason}` : outcome.type,
      networkBytes: attempt.networkReceived,
      writtenBytes: attempt.received,
      ms: Date.now() - attempt.startedAt,
      ...attempt.response
    })

    switch (outcome.type) {
      case 'completed':
        return this.finishCompleted(chunk, self, attempt)
      case 'stopped':
        return this.finishStopped(chunk, self, attempt)
      case 'aborted':
        return this.finishAborted(chunk, self, attempt, outcome.reason)
      case 'failed':
        return this.finishFailed(chunk, self, attempt, outcome.error)
    }
  }

  private finishCompleted(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt
  ): 'continue' {
    const { block } = attempt

    // Another attempt already finished this block: these bytes are surplus.
    if (block.status === 'completed') {
      this.letGo(chunk, self, attempt, false)
      return 'continue'
    }

    this.endAttempt(self, attempt)
    block.status = 'completed'
    block.interfaceId = attempt.networkId
    if (block.rangeEnd !== null) {
      // Progress events can lag the final write, so square the block up to its exact size and
      // credit the shortfall to the network that finished it.
      const blockBytes = block.rangeEnd - block.rangeStart + 1
      chunk.bytesDownloaded += advanceBlock(block, attempt.networkId, blockBytes)
      self.lastBlockSpeed =
        (attempt.networkReceived /
          Math.max(1, (attempt.lastNetworkAt || Date.now()) - attempt.startedAt)) *
        1000
    }
    self.failures = 0
    self.strikes = 0
    // Whoever is still racing for the block has lost.
    for (const rival of this.attempts.get(block.index) ?? []) this.abortAttempt(rival, 'lost')
    recomputeAggregates(this.runtime.state, this.runtime.blocks)
    this.host.scheduleUpdate()
    return 'continue'
  }

  /** The stream was stopped while its request was in flight. */
  private finishStopped(chunk: HttpStreamState, self: ChunkRuntime, attempt: Attempt): 'stop' {
    // Whatever stopped it — a pause, a cancel, retirement — the block goes back as any other
    // attempt's would, and one another attempt has finished stays finished.
    this.letGo(chunk, self, attempt, false)
    chunk.status = this.runtime.state.status === 'paused' ? 'paused' : 'cancelled'
    return 'stop'
  }

  private async finishAborted(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt,
    reason: AbortReason
  ): Promise<'continue'> {
    // 'lost': another attempt decided the block, so its state is no longer this one's to touch.
    // 'refresh': not a failure — no retry counted, no backoff. Whoever takes the block next
    // resumes it from the staging file on a new connection.
    this.letGo(chunk, self, attempt, reason === 'refresh' && attempt.networkReceived === 0)
    if (reason === 'refresh' && attempt.kind === 'primary') {
      // A moment before this stream asks again, so that a connection already proven fast, if
      // there is one, gets to the block before this one does.
      this.host.scheduleUpdate()
      await delay(REFRESH_HANDOFF_MS, self.wait)
      self.warmSince = Date.now()
      self.slowSince = null
    }
    return 'continue'
  }

  private async finishFailed(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    const message = error instanceof Error ? error.message : String(error)
    const network = this.network(attempt.networkId)
    const deliveredNothing = attempt.networkReceived === 0

    if (error instanceof RemoteChangedError) {
      const verdict =
        error.check.kind === 'size'
          ? 'different'
          : await this.confirmSameBytes(self.connection, error.seen)
      // The check takes a moment; the download may have been paused or stopped meanwhile.
      if ((this.runtime.state.status as DownloadStatus) !== 'downloading') {
        return this.finishStopped(chunk, self, attempt)
      }
      if (verdict === 'same') {
        // Same bytes under another label — accept it and fetch again straight away; nothing from
        // the rejected response was written.
        if (compareVersion(this.acceptedVersions, error.seen).kind !== 'same') {
          this.acceptedVersions.push(error.seen)
        }
        this.letGo(chunk, self, attempt, false)
        return 'continue'
      }
      if (verdict === 'different') {
        // Every other worker would hit the same new version, so stop them all now rather than
        // let each burn through its retries first. What's on disk is of the old version: no use.
        this.host.failDownload(message, true)
        return this.finishStopped(chunk, self, attempt)
      }
      // 'unknown' — nothing to compare yet, or the check itself failed: retry like any other
      // failed request. Nothing wrong was written either way.
    }

    if (error instanceof NoCompatibleRouteError) {
      // A redirect can move this worker to a host its network cannot reach, and no retry over
      // it will change that. Its block goes back to the queue for another network.
      this.letGo(chunk, self, attempt, deliveredNothing)
      this.host.failNetwork(network, message)
      return 'stop'
    }

    // What the server's answer says about the network: a connection failing while the whole
    // network has gone quiet means the network can't reach the server — dropped, or connected
    // with no way through. It stops being used, bar one stream that keeps trying (see reconcile).
    if (error instanceof ConnectionError && this.markUnreachable(network, Date.now())) {
      this.host.reconcile()
    }

    // A hedge is optional work: its failure isn't retried, and what it did write stays.
    if (attempt.kind === 'hedge') {
      this.letGo(chunk, self, attempt, deliveredNothing)
      return 'continue'
    }

    // A network that can't get through retries as a matter of course: that's not news.
    if (network.status === 'on') network.retries += 1
    // What arrived before it failed shows the network works, and what was written shows the
    // server does: the count in a row starts over, and so does the backoff.
    if (attempt.networkReceived > 0) self.failures = 0
    if (attempt.received > 0) {
      self.strikes = 0
      self.busySince = null
    }
    self.failures += 1
    // Back to the queue, so any available worker can pick it up.
    this.letGo(chunk, self, attempt, deliveredNothing)

    // A connection that failed is the network's doing, and is tried again for as long as the
    // network is there. A server that answered wrongly gets MAX_CHUNK_RETRIES in a row, and one
    // that answered busy is waited out for SERVER_BUSY_FOR_MS as well; then this stream gives up,
    // and once all its network's have, so does the network.
    const now = Date.now()
    // The server turning a request away: the stream count takes it as a limit (see
    // concurrency.ts).
    if (error instanceof HttpStatusError && [403, 429, 503].includes(error.status)) {
      self.refused = true
    }
    const busy = error instanceof HttpStatusError && error.transient
    if (busy) self.busySince ??= now
    const waitingOut = busy && now - (self.busySince ?? now) < SERVER_BUSY_FOR_MS
    if (!(error instanceof ConnectionError) && ++self.strikes > MAX_CHUNK_RETRIES && !waitingOut) {
      self.retiring = true
      if (this.liveStreams(network.id).length === 0) {
        this.host.failNetwork(network, message)
      }
      return 'stop'
    }

    let wait = retryDelayMs(self.failures)
    if (network.status === 'unreachable') wait = Math.min(wait, UNREACHABLE_RETRY_MS)
    if (error instanceof HttpStatusError && error.transient && error.retryAfterMs !== null) {
      // Asked of whoever sent it — this network's address, to the server — not of this one
      // request: none of the network's streams sends another until then.
      const asked = Math.min(error.retryAfterMs, RETRY_AFTER_MAX_MS)
      wait = Math.max(wait, asked)
      this.holdUntil.set(network.id, Math.max(this.holdUntil.get(network.id) ?? 0, now + asked))
    }

    chunk.status = 'retrying'
    this.host.scheduleUpdate()
    await this.backOff(self, wait)
    const statusAfterDelay = this.runtime.state.status as DownloadStatus
    if (self.controller.signal.aborted || statusAfterDelay !== 'downloading') {
      chunk.status = statusAfterDelay === 'paused' ? 'paused' : 'cancelled'
      chunk.speedBytesPerSec = 0
      return 'stop'
    }
    this.goIdle(chunk)
    self.warmSince = Date.now()
    self.slowSince = null
    return 'continue'
  }

  /**
   * The stream stops working on the attempt's block without having finished it. A primary hands
   * the block back to the queue; a hedge just drops out. Either way what it wrote stays counted.
   * When the attempt delivered nothing, its network is remembered (see scheduler.ts).
   */
  private letGo(
    chunk: HttpStreamState,
    self: ChunkRuntime,
    attempt: Attempt,
    deliveredNothing: boolean
  ): void {
    this.endAttempt(self, attempt)
    const { block } = attempt
    // A block another attempt has finished stays finished.
    if (attempt.kind === 'primary' && block.status === 'downloading') block.status = 'pending'
    if (deliveredNothing) this.avoidNetworkByBlock.set(block.index, attempt.networkId)
    this.goIdle(chunk)
  }

  private concurrencySnapshot(): Snapshot {
    const inUse = this.runtime.state.networks.filter((network) => network.status === 'on')
    // Held only counts while the disk is still taking this download's writes (see concurrency.ts).
    const landing = [...this.chunkRuntimes.values()].some((self) => self.wrote)
    const networks = inUse.map(({ id }) => {
      let streams = 0
      let answered = 0
      let refused = 0
      let served = 0
      let held = 0
      for (const chunk of this.liveStreams(id)) {
        const self = this.chunkRuntimes.get(chunk.id)
        streams++
        if (self && self.receivedBytes > 0) answered++
        if (self?.refused) refused++
        if (self?.served) served++
        if (landing && self?.attempt?.writeWaiting) held++
      }
      return { id, streams, answered, refused, served, held }
    })
    // A new stream takes a waiting block the moment it starts.
    const waiting = this.runtime.blocks.filter((block) => block.status === 'pending').length
    return { now: Date.now(), networks, spareWork: waiting }
  }

  /** New streams on `networkId`, put on the download's list for the caller to start. */
  private addStreams(networkId: string, count: number): HttpStreamState[] {
    let id = Math.max(-1, ...this.runtime.state.streams.map((chunk) => chunk.id))
    const added = Array.from({ length: count }, () => newStream(++id, networkId))
    this.runtime.state.streams.push(...added)
    this.runtime.state.peakStreams = Math.max(
      this.runtime.state.peakStreams ?? 0,
      this.runtime.state.streams.length
    )
    debug('streams', { network: networkId, added: count })
    this.host.scheduleUpdate()
    return added
  }

  /** Stops `count` streams on `networkId` for good. Stopping partway through a block
   * costs nothing: what it wrote stays, and whoever takes the block next resumes from there. */
  private retireStreams(networkId: string, count: number): void {
    if (count < 1) return
    // Streams the server just refused go first (see concurrency.ts), then ones whose last
    // request failed, then the newest.
    const rank = (chunk: HttpStreamState): number => {
      const self = this.chunkRuntimes.get(chunk.id)
      return self?.refused ? 2 : (self?.failures ?? 0) > 0 ? 1 : 0
    }
    const order = this.liveStreams(networkId).sort((a, b) => rank(b) - rank(a) || b.id - a.id)
    for (const chunk of order.slice(0, count)) {
      const self = this.chunkRuntimes.get(chunk.id)
      if (self && this.workers.has(chunk.id)) {
        // Its worker takes it off the list once it has stopped.
        self.retiring = true
        self.controller.abort()
      } else {
        this.removeStream(chunk)
      }
    }
    debug('streams', { network: networkId, retired: count })
  }

  /** Takes a retired stream off the list. */
  private removeStream(chunk: HttpStreamState): void {
    this.chunkRuntimes.delete(chunk.id)
    this.runtime.meters.connections.delete(chunk.id)
    const index = this.runtime.state.streams.indexOf(chunk)
    if (index < 0) return
    this.runtime.state.streams.splice(index, 1)
    this.host.scheduleUpdate()
  }

  private async runWorker(chunk: HttpStreamState): Promise<void> {
    const controller = new AbortController()
    const self: ChunkRuntime = {
      controller,
      wait: AbortSignal.any([controller.signal, this.runtime.stop.signal]),
      nudge: new AbortController(),
      connection: new StreamConnection(() => this.host.networks.find(chunk.interfaceId), {
        timeoutMs: testKnobs.stallTimeoutMs,
        connectTimeoutMs: testKnobs.connectTimeoutMs
      }),
      attempt: null,
      warmSince: Date.now(),
      slowSince: null,
      lastBlockSpeed: 0,
      receivedBytes: 0,
      failures: 0,
      strikes: 0,
      busySince: null,
      refused: false,
      served: false,
      wrote: false,
      retiring: false
    }
    this.chunkRuntimes.set(chunk.id, self)

    try {
      while (this.runtime.state.status === 'downloading') {
        if (controller.signal.aborted || self.retiring) break

        // The server asked this network to hold off: no new request over it until then. Each
        // stream comes back a little apart from the others.
        const holdFor = (this.holdUntil.get(chunk.interfaceId) ?? 0) - Date.now()
        if (holdFor > 0) {
          this.goIdle(chunk)
          chunk.status = 'retrying'
          this.host.scheduleUpdate()
          await this.backOff(self, holdFor + Math.random() * Math.min(1000, holdFor / 10))
          continue
        }

        // Taken atomically: nothing between choosing the work and registering it can yield.
        const work = pickWork(
          {
            blocks: this.runtime.blocks,
            streams: this.runtime.state.streams,
            attempts: this.attempts,
            avoid: this.avoidNetworkByBlock,
            hedgesUsed: this.hedgesByBlock
          },
          {
            id: chunk.id,
            networkId: chunk.interfaceId,
            speedBytesPerSec: self.lastBlockSpeed || undefined
          },
          Date.now(),
          SCHEDULER_POLICY
        )
        if (!work) {
          this.goIdle(chunk)
          // While blocks are still in flight, stay available in case one fails and is handed back,
          // or turns out to be slow enough to be worth racing.
          if (
            this.runtime.blocks.some((b) => b.status === 'pending' || b.status === 'downloading')
          ) {
            this.host.scheduleUpdate()
            await delay(IDLE_POLL_MS, self.wait)
            continue
          }
          chunk.status = 'completed'
          this.host.scheduleUpdate()
          break
        }

        const attempt = this.beginAttempt(chunk, self, work)
        this.host.scheduleUpdate()
        const outcome = await this.executeAttempt(chunk, self, attempt)
        let next: 'continue' | 'stop'
        try {
          next = await this.finishAttempt(chunk, self, attempt, outcome)
        } finally {
          this.endAttempt(self, attempt)
        }
        if (next === 'stop') break
      }
    } finally {
      // Its sockets would otherwise stay open, kept alive for requests that will never come.
      self.connection.close()
    }

    this.host.scheduleUpdate()
  }

  /**
   * Settles whether a server labelling the file differently (new ETag or Last-Modified, same
   * size) is serving the same bytes — load-balanced servers often disagree on labels for
   * identical files — or a new version. Re-fetches a spread of bytes this download already has
   * on disk, from a server presenting the new label, and compares them.
   *
   * 'unknown' when there's nothing on disk to compare yet or the samples couldn't be fetched;
   * the caller then treats the response as an ordinary failed request and retries.
   */
  private async confirmSameBytes(
    connection: StreamConnection,
    seen: FileVersion
  ): Promise<'same' | 'different' | 'unknown'> {
    if (compareVersion(this.acceptedVersions, seen).kind === 'same') return 'same'

    // Every byte on disk came from an accepted version: mismatched responses are rejected
    // before anything is written.
    const withData = this.runtime.blocks.filter((block) => block.bytesDownloaded > 0)
    const step = Math.max(1, withData.length / MAX_SAMPLES)
    const picks = Array.from(
      { length: Math.min(MAX_SAMPLES, withData.length) },
      (_, i) => withData[Math.floor(i * step)]
    )

    let compared = 0
    for (const block of picks) {
      let local: Buffer
      try {
        local = await this.runtime.file.read(
          block.rangeStart,
          Math.min(SAMPLE_BYTES, block.bytesDownloaded)
        )
      } catch {
        continue
      }
      if (local.length === 0) continue

      for (let tries = 0; tries < SAMPLE_TRIES; tries++) {
        try {
          const remote = await fetchRange(
            this.runtime.requestPayload.url,
            block.rangeStart,
            block.rangeStart + local.length - 1,
            connection
          )
          // A reply from a server still presenting an accepted label proves nothing here.
          if (compareVersion([seen], remote.version).kind !== 'same') continue
          if (!remote.body.equals(local)) return 'different'
          compared += 1
          break
        } catch {
          return 'unknown'
        }
      }
    }
    return compared > 0 ? 'same' : 'unknown'
  }
}
