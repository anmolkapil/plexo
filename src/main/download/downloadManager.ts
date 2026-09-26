import { randomUUID } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, Notification, powerSaveBlocker } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  BlockState,
  ChunkState,
  DownloadNetwork,
  DownloadState,
  DownloadStatus,
  DownloadUpdate,
  NetworkInterfaceInfo,
  NetworkStatus,
  StartDownloadRequest
} from '../../shared/types'
import { testKnobs, testStreamsPerNetwork } from '../testKnobs'
import { advanceBlock, retractBlock } from './blockProgress'
import {
  ConcurrencyController,
  type Action,
  type ConcurrencyPolicy,
  type Snapshot
} from './concurrency'
import { downloadChunk, fetchRange, HttpStatusError, RemoteChangedError } from './chunkDownloader'
import { DownloadFile } from './downloadFile'
import { compareVersion, type FileVersion } from './fileVersion'
import { ensureDirectory, reserveDestinationPath } from './paths'
import {
  interleave,
  MAX_STREAMS_PER_NETWORK,
  planBlocks,
  planDownload,
  startingStreams
} from './plan'
import { restoreBlocks, saveBlocks, type SavedBlocks } from './savedProgress'
import { pickWork, type SchedulerPolicy, type Work } from './scheduler'
import type { NetworkMonitor } from '../network/interfaces'
import {
  compatibleInterfaces,
  ConnectionError,
  NoCompatibleRouteError,
  resolveTargetWithin,
  StreamConnection,
  targetHost
} from '../network/routes'

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
  block: BlockState
  streamId: number
  networkId: string
  /** Where the request begins, as an offset into the block. Null until it is known. */
  startOffset: number | null
  /** Bytes the destination writer has accepted; safe to resume from this prefix. */
  received: number
  /** Bytes the network has delivered, independently of disk backpressure. */
  networkReceived: number
  lastNetworkAt: number
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
   * measured from. (`ChunkState.bytesDownloaded` counts only bytes that were new.) */
  receivedBytes: number
  /** Failed attempts in a row, for backoff. */
  failures: number
  /** Of those, the ones the server answered wrongly: MAX_CHUNK_RETRIES of them and it gives up.
   * A connection that failed isn't one — see finishFailed. */
  strikes: number
  /** When the server first answered busy (see HttpStatusError.transient) since this stream last
   * made progress: a busy server is waited out for SERVER_BUSY_FOR_MS, not MAX_CHUNK_RETRIES. */
  busySince: number | null
  /** Stopped for good, and to leave the list once its worker has (see retireStreams). */
  retiring: boolean
}

interface SpeedSample {
  bytes: number
  time: number
}

interface DownloadRuntime {
  state: DownloadState
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  requestPayload: StartDownloadRequest
  credentialsRequiredAfterRestart: boolean
  chunkRuntimes: Map<number, ChunkRuntime>
  /** The running streams' workers, by stream id. Empty unless the download is running. */
  workers: Map<number, Promise<void>>
  /** Aborted once the current run is over — stopped (a pause, a cancel, an error) or every
   * block in — so nothing starts streams for it and no stream waits on. */
  stop: AbortController
  /** Each network's status as reconcile last left it; how it tells a network that has just come
   * into use. Cleared at the start of each run. */
  reconciled: Map<string, NetworkStatus>
  file: DownloadFile
  runPromise?: Promise<void>
  publishing: boolean
  speedSamplesByChunk: Map<number, SpeedSample[]>
  pushScheduled: boolean
  blocks: BlockState[]
  totalBlocks: number
  persistenceTimer?: NodeJS.Timeout
  persistenceChain: Promise<void>
  removed: boolean
  /** The version this download started on, plus any since confirmed to serve identical bytes
   * (see confirmSameBytes). Not persisted: after a restart, a confirmation is simply redone. */
  acceptedVersions: FileVersion[]
  /** Slow-connection refreshes per block index, capped at MAX_REFRESHES_PER_BLOCK. */
  refreshesByBlock: Map<number, number>
  /** For a block whose last attempt delivered nothing, the network that made it. That network
   * leaves the block to another one while another is free to take it (see scheduler.ts). Not
   * persisted: it only steers the next hand-out. */
  avoidNetworkByBlock: Map<number, string>
  /** Attempts in flight, by block index. */
  attempts: Map<number, Attempt[]>
  /** Hedges started per block index, capped at SCHEDULER_POLICY.maxHedgesPerBlock. */
  hedgesByBlock: Map<number, number>
  /** By network id: everything its streams have received, which is what the stream count is
   * judged by (see concurrency.ts), and when it last showed it was alive — received something,
   * or came into use. */
  traffic: Map<string, { received: number; aliveAt: number }>
  /** By network id: until when the server asked (Retry-After) not to be sent new requests over
   * it. */
  holdUntil: Map<string, number>
  /** Decides how many streams each network runs; kept for the whole download, so a pause and
   * resume doesn't forget what it has found out. */
  concurrency: ConcurrencyController | null
  /** Updates sent to the window so far (see DownloadUpdate). */
  sentUpdates: number
  /** Each block as the window was last sent it, by index — what tells a changed block apart. */
  sentBlocks: Pick<BlockState, 'status' | 'interfaceId' | 'bytesDownloaded'>[]
}

interface PersistedDownloadBase {
  savedAt: number
  partialPath: string
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  /** Request options persisted to disk. Custom headers (cookies, auth) are kept in memory only and never written to disk. */
  requestPayload: Omit<StartDownloadRequest, 'headers'>
  credentialsRequiredAfterRestart?: boolean
  /** The networks, as saved before a download listed them in its state. Read only to fill in
   * `networks` for a download saved that way. */
  activeInterfaces?: NetworkInterfaceInfo[]
}

type PersistedDownload = PersistedDownloadBase &
  (
    | ({ version: 5; state: Omit<DownloadState, 'blocks'> } & SavedBlocks)
    /** Written before version 5, with every block saved whole; still read, so an update doesn't
     * lose the progress of a download it finds paused. */
    | { version: 4; state: DownloadState }
  )

// Set PLEXO_DEBUG=1 to log every request's outcome, how long the server took to answer and
// whether it reused a warm connection — what it takes to tell one slow connection from a slow path.
const debug: (...args: unknown[]) => void = process.env['PLEXO_DEBUG']
  ? (...args) => console.debug('[plexo]', ...args)
  : () => {}

const UI_UPDATE_MS = 200
/** How often a running download takes stock (see run). */
const TICK_MS = 500
// Syncing a growing file can briefly monopolize a slow destination drive. Keep recovery
// checkpoints independent of UI updates; pause and publication still force an immediate sync.
const CHECKPOINT_INTERVAL_MS = 15_000

// Raw per-event deltas are too noisy to display (socket buffers flush in
// irregular bursts a few ms apart). Averaging over a few seconds instead
// gives a speed/ETA reading that tracks reality without jumping around.
const SPEED_WINDOW_MS = 3000

// Appends a sample and returns the average byte rate over SPEED_WINDOW_MS.
function pushSpeedSample(samples: SpeedSample[], bytes: number, time: number): number {
  if (samples.length > 0 && time - samples[samples.length - 1].time > SPEED_WINDOW_MS) {
    samples.length = 0
  }
  samples.push({ bytes, time })

  return calculateCurrentSpeed(samples, time)
}

function calculateCurrentSpeed(samples: SpeedSample[] | undefined, time: number): number {
  if (!samples || samples.length === 0) return 0

  const latest = samples[samples.length - 1]
  if (time - latest.time > SPEED_WINDOW_MS) {
    return 0
  }

  const cutoff = time - SPEED_WINDOW_MS
  while (samples.length > 2 && samples[1].time <= cutoff) {
    samples.shift()
  }

  // At least a second: a fresh window can hold two samples ms apart, and one socket burst over a
  // few ms reads as a speed the connection never had (and sticks as the UI's peak).
  const oldest = samples[0]
  const deltaSeconds = Math.max((time - oldest.time) / 1000, 1)
  return (latest.bytes - oldest.bytes) / deltaSeconds
}

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
  maxHedgesPerBlock: 2
}
const CONCURRENCY_POLICY: ConcurrencyPolicy = {
  maxPerNetwork: MAX_STREAMS_PER_NETWORK,
  windowMs: testKnobs.probeWindowMs,
  warmupMs: testKnobs.probeWindowMs,
  minGain: 0.15,
  maxWindows: 4
}

/** Whether the file can be fetched in parts. Otherwise one request has to carry all of it: one
 * stream, on one network. */
function splittable(request: StartDownloadRequest): boolean {
  return request.supportsRanges && request.totalBytes > 0
}

/** How many streams a download runs is only for it to work out when there can be more than one,
 * and unless a test fixes it. */
function concurrencyFor(request: StartDownloadRequest): ConcurrencyController | null {
  return splittable(request) && testStreamsPerNetwork() === null
    ? new ConcurrencyController(CONCURRENCY_POLICY)
    : null
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

/** Brings every stream's speed up to date, and each network's and the download's with them. */
function updateSpeeds(runtime: DownloadRuntime, now = Date.now()): void {
  let total = 0
  const byNetwork = new Map<string, number>()
  for (const chunk of runtime.state.chunks) {
    if (chunk.status === 'downloading') {
      const samples = runtime.speedSamplesByChunk.get(chunk.id)
      chunk.speedBytesPerSec = calculateCurrentSpeed(samples, now)
    }
    total += chunk.speedBytesPerSec
    byNetwork.set(
      chunk.interfaceId,
      (byNetwork.get(chunk.interfaceId) ?? 0) + chunk.speedBytesPerSec
    )
  }
  for (const network of runtime.state.networks) {
    network.speedBytesPerSec = byNetwork.get(network.id) ?? 0
  }
  runtime.state.speedBytesPerSec = total
}

/** Nothing is moving: a paused or stopped download reads 0 everywhere. */
function clearSpeeds(state: DownloadState): void {
  state.speedBytesPerSec = 0
  for (const chunk of state.chunks) chunk.speedBytesPerSec = 0
  for (const network of state.networks) network.speedBytesPerSec = 0
}

/** Waits, but returns early if the signal aborts (pause/cancel shouldn't wait out a retry backoff). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function newStream(id: number, networkId: string): ChunkState {
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

function newNetwork(iface: NetworkInterfaceInfo, enabled: boolean): DownloadNetwork {
  return {
    id: iface.id,
    label: iface.displayName,
    kind: iface.kind,
    enabled,
    status: enabled ? 'on' : 'off',
    bytesDownloaded: 0,
    speedBytesPerSec: 0,
    retries: 0
  }
}

/** A runtime for `state`, with nothing running. */
function newRuntime(
  state: DownloadState,
  requestPayload: StartDownloadRequest,
  file: DownloadFile,
  blocks: BlockState[]
): DownloadRuntime {
  return {
    state,
    requestPayload,
    credentialsRequiredAfterRestart: false,
    chunkRuntimes: new Map(),
    workers: new Map(),
    stop: new AbortController(),
    reconciled: new Map(),
    file,
    publishing: false,
    speedSamplesByChunk: new Map(),
    pushScheduled: false,
    blocks,
    totalBlocks: state.totalBlocks ?? blocks.length,
    persistenceChain: Promise.resolve(),
    removed: false,
    acceptedVersions: [requestedVersion(requestPayload)],
    refreshesByBlock: new Map(),
    avoidNetworkByBlock: new Map(),
    attempts: new Map(),
    hedgesByBlock: new Map(),
    traffic: new Map(),
    holdUntil: new Map(),
    concurrency: concurrencyFor(requestPayload),
    sentUpdates: 0,
    sentBlocks: []
  }
}

function requestedVersion(request: StartDownloadRequest): FileVersion {
  return { etag: request.etag, lastModified: request.lastModified, totalBytes: request.totalBytes }
}

// How much of the already-downloaded file to re-fetch and compare when a server labels a
// response with an ETag or Last-Modified this download hasn't seen before.
const SAMPLE_BYTES = 16 * 1024
const MAX_SAMPLES = 8
/** A sample must come from a server presenting the new label; behind a load balancer the next
 * request may land on another one, so take a few tries at reaching it. */
const SAMPLE_TRIES = 4

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** The staging file is on the destination volume and becomes the final file by rename. */
async function ensureDiskSpace(destinationDir: string, requiredBytes: number): Promise<void> {
  if (requiredBytes <= 0) return // unknown size — nothing to check against
  const stats = await statfs(destinationDir)
  const availableBytes = stats.bavail * stats.bsize
  if (availableBytes < requiredBytes) {
    throw new Error(
      `Not enough disk space: this download needs ${formatGigabytes(requiredBytes)} but only ${formatGigabytes(availableBytes)} is free`
    )
  }
}

export class DownloadManager {
  private runtimes = new Map<string, DownloadRuntime>()
  private readonly initialization: Promise<void>
  private suspending = false
  /** Each network's addresses as last seen, by id: what tells a network that has changed. */
  private seenAddresses = new Map<string, string[]>()
  /** The powerSaveBlocker keeping the computer awake while a download runs (see keepAwake). */
  private awakeBlocker: number | null = null

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor
  ) {
    this.initialization = this.restorePersistedDownloads()
  }

  private downloadsRoot(): string {
    return join(app.getPath('userData'), 'downloads')
  }

  private downloadDir(id: string): string {
    return join(this.downloadsRoot(), id)
  }

  private manifestPath(id: string): string {
    return join(this.downloadDir(id), 'manifest.json')
  }

  private async restorePersistedDownloads(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.downloadsRoot())
    } catch {
      return
    }

    const restored: DownloadRuntime[] = []
    await Promise.all(
      entries.map(async (id) => {
        try {
          await rm(`${this.manifestPath(id)}.tmp`, { force: true })
          const persisted = JSON.parse(
            await readFile(this.manifestPath(id), 'utf-8')
          ) as PersistedDownload
          if (persisted.state.id !== id) return
          const blocks =
            persisted.version === 5
              ? restoreBlocks(persisted.state, persisted)
              : persisted.version === 4
                ? persisted.state.blocks
                : undefined
          if (!blocks) return
          const state: DownloadState = {
            ...persisted.state,
            // Saved before downloads listed their networks: the ones it ran on, all in use.
            networks:
              (persisted.state.networks as DownloadNetwork[] | undefined) ??
              (persisted.activeInterfaces ?? []).map((iface) => newNetwork(iface, true)),
            // Streams are only for a run; a resumed download starts its own.
            chunks: [],
            blocks
          }
          if (state.status === 'downloading') {
            state.status = 'paused'
            state.pausedAt = persisted.savedAt || Date.now()
          }
          clearSpeeds(state)
          for (const block of blocks) {
            if (block.status === 'downloading') block.status = 'pending'
          }

          const file = new DownloadFile(persisted.partialPath)
          if (state.status === 'paused') {
            const size = await file.size().catch(() => -1)
            const publishedPath = persisted.publicationPath ?? state.destinationPath
            const published = await stat(publishedPath).catch(() => null)
            const publishedSize = published?.size ?? -1
            const expected = state.totalBytes || state.bytesDownloaded
            const sameFile =
              !!published &&
              (size >= 0
                ? await stat(file.path)
                    .then(
                      (partial) => partial.dev === published.dev && partial.ino === published.ino
                    )
                    .catch(() => false)
                : persisted.publicationIdentity?.dev === published.dev &&
                  persisted.publicationIdentity?.ino === published.ino)
            if (
              blocks.every((block) => block.status === 'completed') &&
              publishedSize === expected &&
              sameFile
            ) {
              state.status = 'completed'
              state.destinationPath = publishedPath
              state.fileName = basename(publishedPath)
              state.error = undefined
              state.completedAt ??= persisted.savedAt
              if (size >= 0) await file.discard()
            } else if (size < 0) {
              state.status = 'error'
              state.error =
                'The partial download file is missing. Remove this download and start again.'
              state.resumable = false
            } else {
              for (const block of blocks) {
                const length = block.rangeEnd === null ? 0 : block.rangeEnd - block.rangeStart + 1
                if (
                  block.rangeStart + block.bytesDownloaded > size ||
                  (block.status === 'completed' && block.bytesDownloaded !== length)
                ) {
                  block.status = 'pending'
                  block.bytesDownloaded = 0
                  block.bytesByInterface = {}
                }
              }
              state.bytesDownloaded = blocks.reduce((sum, block) => sum + block.bytesDownloaded, 0)
            }
          }

          const runtime = newRuntime(state, persisted.requestPayload, file, blocks)
          runtime.publicationPath = persisted.publicationPath
          runtime.publicationIdentity = persisted.publicationIdentity
          runtime.credentialsRequiredAfterRestart = persisted.credentialsRequiredAfterRestart ?? false
          this.recomputeAggregates(runtime)
          restored.push(runtime)
        } catch {
          // Ignore incomplete or corrupt manifests; other downloads can still be restored.
        }
      })
    )

    // Plexo only ever tracks one current download — getCurrentDownload() always returns
    // whichever restored runtime started most recently. Any other one restored alongside it is
    // an orphan (most likely left over from before concurrent starts were blocked): nothing
    // would ever look at it again, so left in `runtimes` it would sit there forever, invisibly
    // failing every future start() with "a download is already in progress".
    restored.sort((a, b) => b.state.startedAt - a.state.startedAt)
    const [current, ...orphans] = restored

    await Promise.all(
      orphans.map((runtime) =>
        this.removePersistedDownload(runtime, runtime.file.path !== current?.file.path)
      )
    )

    if (current) {
      if (current.state.status === 'completed' && current.publicationIdentity) {
        const published = await stat(current.state.destinationPath).catch(() => null)
        if (
          published?.dev === current.publicationIdentity.dev &&
          published.ino === current.publicationIdentity.ino
        ) {
          await current.file.discard().catch(() => {})
        }
      }
      this.runtimes.set(current.state.id, current)
      await this.persistNow(current)
    }
  }

  /** A snapshot of the current download: an update with every block in it. */
  async getCurrentDownload(): Promise<DownloadUpdate | null> {
    await this.initialization
    const latest = [...this.runtimes.values()].sort(
      (a, b) => b.state.startedAt - a.state.startedAt
    )[0]
    if (!latest) return null
    const { blocks, ...state } = latest.state
    return structuredClone({ seq: latest.sentUpdates, state, blocks: blocks ?? latest.blocks })
  }

  /** Plexo shows one download at a time (see useAppStore's currentDownload) — starting a second
   * one while one is already running or paused would silently race it for disk I/O and
   * scramble the renderer's single-download view as updates from both interleave. */
  hasActiveDownload(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status === 'downloading' || runtime.state.status === 'paused') {
        return true
      }
    }
    return false
  }

  async start(requestPayload: StartDownloadRequest): Promise<string> {
    await this.initialization
    if (this.hasActiveDownload()) {
      throw new Error('A download is already in progress — finish or remove it first.')
    }

    const available = await this.networks.refresh()
    const selected = available.filter((iface) => requestPayload.interfaceIds.includes(iface.id))
    if (selected.length === 0) {
      throw new Error('Select at least one network interface')
    }
    const target = new URL(requestPayload.url)
    // A selected network that can't reach the host's address family starts switched off.
    const usable = compatibleInterfaces(
      selected,
      await resolveTargetWithin(targetHost(target), testKnobs.stallTimeoutMs)
    )
    if (usable.length === 0) throw new NoCompatibleRouteError(targetHost(target))

    await ensureDirectory(requestPayload.destinationDir)
    await ensureDiskSpace(requestPayload.destinationDir, requestPayload.totalBytes)

    const plan = planDownload({
      totalBytes: requestPayload.totalBytes,
      splittable: requestPayload.supportsRanges,
      networkCount: usable.length,
      maxBlockBytes: testKnobs.blockBytes // 8 MB outside tests
    })

    // Claimed on disk, not just picked, so a second download of the same file
    // name can't pick it too and overwrite this one at publish time. Done
    // before anything else is created, so a destination we can't write to
    // leaves nothing behind.
    const destinationPath = await reserveDestinationPath(
      requestPayload.destinationDir,
      requestPayload.suggestedFileName
    )

    const id = randomUUID()
    const file = new DownloadFile(`${destinationPath}.plexo`)

    // The UI caps how many cells it renders separately (see BlockGrid), by bucketing these
    // blocks rather than by shrinking their count here.
    const blocks = planBlocks(requestPayload.totalBytes, plan.blockSizeBytes)

    // The computer's other networks are listed too, switched off, for the user to turn on.
    const networks = available.map((iface) => newNetwork(iface, usable.includes(iface)))
    // Unsplittable: one network carries it (IdleScreen lets only one be picked).
    if (!splittable(requestPayload)) {
      for (const network of networks) network.enabled &&= network.id === usable[0].id
      for (const network of networks) network.status = network.enabled ? 'on' : 'off'
    }

    const state: DownloadState = {
      id,
      url: requestPayload.url,
      fileName: basename(destinationPath),
      destinationPath,
      totalBytes: requestPayload.totalBytes,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'downloading',
      networks,
      chunks: [],
      peakStreams: 0,
      blocks,
      totalBlocks: blocks.length,
      blockSizeBytes: plan.blockSizeBytes,
      startedAt: Date.now()
    }

    const runtime = newRuntime(state, requestPayload, file, blocks)
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)

    runtime.runPromise = this.run(runtime)

    return id
  }

  async pause(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'downloading' || runtime.publishing) return

    runtime.state.status = 'paused'
    runtime.state.pausedAt = Date.now()
    clearSpeeds(runtime.state)
    for (const chunk of runtime.state.chunks) {
      if (chunk.status !== 'completed') {
        chunk.status = 'paused'
      }
      chunk.currentBlockIndex = undefined
      chunk.hedge = undefined
    }
    for (const block of runtime.blocks) {
      if (block.status === 'downloading') {
        block.status = 'pending'
      }
    }
    runtime.avoidNetworkByBlock.clear()
    this.stopRun(runtime)
    this.pushUpdate(runtime)
    await runtime.runPromise
    await this.persistNow(runtime)
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    const { status, resumable } = runtime.state
    if (status !== 'paused' && !(status === 'error' && resumable !== false)) return

    void this.resumeAfterVerifying(runtime)
  }

  // A file that changed on the server while this download was paused is caught by the first
  // chunk request after resuming: its response is checked against the version the download
  // started on (see runWorker), which can tell a real change from a relabelled server. Whether a
  // network is there to resume on is the run's business: with none, it waits for one.
  private async resumeAfterVerifying(runtime: DownloadRuntime): Promise<void> {
    // The paused run can still be winding down: a writer closing, a sample check in flight. A new
    // one must not start beside it — both would go on to publish, and act on each other's streams.
    await runtime.runPromise
    // Just after launch the networks may not have been looked at yet.
    await this.networks.refresh()

    if (runtime.credentialsRequiredAfterRestart) {
      runtime.state.status = 'error'
      runtime.state.error =
        'This download used Cookie or Authorization headers and cannot resume after restarting Plexo.'
      this.pushUpdate(runtime)
      return
    }

    if ((await runtime.file.size().catch(() => -1)) < 0) {
      runtime.state.error =
        'The partial download file is unavailable. Reconnect the destination drive and try again.'
      this.pushUpdate(runtime)
      return
    }
    if (runtime.state.status !== 'paused' && runtime.state.status !== 'error') return

    runtime.state.status = 'downloading'
    runtime.state.error = undefined
    runtime.state.resumable = undefined
    // A network that had failed, or couldn't get through, gets another go.
    for (const network of runtime.state.networks) {
      if (network.status === 'failed' || network.status === 'unreachable') {
        network.status = 'on'
        network.error = undefined
      }
    }
    if (runtime.state.pausedAt) {
      runtime.state.totalPausedMs =
        (runtime.state.totalPausedMs || 0) + (Date.now() - runtime.state.pausedAt)
      runtime.state.pausedAt = undefined
    }
    for (const block of runtime.blocks) {
      if (block.status !== 'completed') {
        block.status = 'pending'
      }
    }
    for (const chunk of runtime.state.chunks) {
      if (chunk.status !== 'completed') {
        chunk.status = 'pending'
      }
      runtime.speedSamplesByChunk.delete(chunk.id)
      chunk.speedBytesPerSec = 0
    }
    runtime.avoidNetworkByBlock.clear()
    this.pushUpdate(runtime)

    runtime.runPromise = this.run(runtime)
  }

  /** Switches one of a download's networks on or off, running or paused. The last network in
   * use can't be switched off: pausing is how a download stops. */
  setNetworkEnabled(id: string, networkId: string, enabled: boolean): void {
    const runtime = this.runtimes.get(id)
    const status = runtime?.state.status
    if (!runtime || (status !== 'downloading' && status !== 'paused')) return
    const { networks } = runtime.state
    const network = networks.find((entry) => entry.id === networkId)
    if (!network || network.enabled === enabled) return
    if (!enabled && !networks.some((other) => other !== network && other.enabled)) return
    // A download that can't be split runs over one network: switching one on switches it over.
    if (enabled && !splittable(runtime.requestPayload)) {
      for (const other of networks) other.enabled = false
    }
    network.enabled = enabled
    this.reconcile(runtime)
    this.pushUpdate(runtime)
  }

  /** The computer's networks changed (see NetworkMonitor). A network whose addresses changed
   * gets its streams going again at once: what they were waiting out may be what changed. One
   * that lost an address also drops its sockets, which may be bound to it. Chrome does the same
   * when its IP address changes (ERR_NETWORK_CHANGED). */
  networksChanged(): void {
    const changed = new Set<string>()
    const moved = new Set<string>()
    const seen = new Map<string, string[]>()
    for (const iface of this.networks.current ?? []) {
      const addresses = iface.addresses.map((entry) => entry.address)
      const before = this.seenAddresses.get(iface.id)
      seen.set(iface.id, addresses)
      if (before?.length === addresses.length && before.every((a) => addresses.includes(a))) {
        continue
      }
      changed.add(iface.id)
      if (before?.some((address) => !addresses.includes(address))) moved.add(iface.id)
    }
    this.seenAddresses = seen

    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused') continue
      this.reconcile(runtime)
      this.wake(
        runtime,
        (id) => changed.has(id),
        (id) => moved.has(id)
      )
      this.scheduleUpdate(runtime)
    }
  }

  /** The computer woke from sleep. Its sockets are likely dead, though nothing will say so until
   * a stall watchdog runs out, and every judgement made by the clock (a silent network, a
   * crawling connection, a step of the stream-count controller) spans the sleep. All of it starts
   * over. */
  systemResumed(): void {
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status !== 'downloading') continue
      for (const traffic of runtime.traffic.values()) traffic.aliveAt = now
      for (const self of runtime.chunkRuntimes.values()) {
        self.warmSince = now
        self.slowSince = null
      }
      this.adjustStreams(runtime, runtime.concurrency?.interrupt())
      this.wake(
        runtime,
        () => true,
        () => true
      )
    }
  }

  /**
   * Gets streams going again now, rather than when their backoff runs out: what held them back
   * has changed. The ones `reconnect` picks also drop their sockets, and what they were fetching
   * is taken up again on a new one: a refresh, so nothing is lost and no retry is counted.
   */
  private wake(
    runtime: DownloadRuntime,
    pick: (networkId: string) => boolean,
    reconnect: (networkId: string) => boolean
  ): void {
    for (const chunk of runtime.state.chunks) {
      const self = runtime.chunkRuntimes.get(chunk.id)
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

  /** Keeps the computer from sleeping while a download runs, which would stop it — as
   * qBittorrent and Transmission offer to. The display can still sleep. */
  private keepAwake(): void {
    const running = [...this.runtimes.values()].some(
      (runtime) => runtime.state.status === 'downloading'
    )
    try {
      if (running && this.awakeBlocker === null) {
        this.awakeBlocker = powerSaveBlocker.start('prevent-app-suspension')
      } else if (!running && this.awakeBlocker !== null) {
        powerSaveBlocker.stop(this.awakeBlocker)
        this.awakeBlocker = null
      }
    } catch {
      // Not every desktop can be kept awake; the download runs regardless.
    }
  }

  async cancel(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (
      !runtime ||
      runtime.publishing ||
      (runtime.state.status !== 'downloading' &&
        runtime.state.status !== 'paused' &&
        runtime.state.status !== 'error')
    )
      return

    runtime.state.status = 'cancelled'
    clearSpeeds(runtime.state)
    for (const chunk of runtime.state.chunks) chunk.status = 'cancelled'
    this.stopRun(runtime)
    this.pushUpdate(runtime, false)
    await runtime.runPromise
    await runtime.file.discard()
    await this.removePersistedDownload(runtime)
  }

  async remove(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (
      runtime &&
      (runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'error')
    ) {
      await this.cancel(id)
    }
    this.runtimes.delete(id)
    if (runtime) await this.removePersistedDownload(runtime)
  }

  async suspendAll(): Promise<void> {
    await this.initialization
    this.suspending = true
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        if (runtime.state.status === 'downloading') await this.pause(runtime.state.id)
        else await this.persistNow(runtime)
      })
    )
  }

  /**
   * Runs the download until every block is in, or it is stopped. Each TICK_MS, and whenever a
   * stream ends, it takes stock: speeds, stuck connections, which networks run streams (see
   * reconcile) and how many (see concurrency.ts). With no network to use, it waits for one.
   */
  private async run(runtime: DownloadRuntime): Promise<void> {
    if (runtime.stop.signal.aborted) runtime.stop = new AbortController()
    runtime.reconciled.clear()
    const { signal } = runtime.stop
    this.reconcile(runtime)

    while (
      runtime.state.status === 'downloading' &&
      runtime.blocks.some((block) => block.status !== 'completed')
    ) {
      await Promise.race([delay(TICK_MS, signal), ...runtime.workers.values()])
      if ((runtime.state.status as DownloadStatus) !== 'downloading') break
      const now = Date.now()
      const speed = runtime.state.speedBytesPerSec
      updateSpeeds(runtime, now)
      if (runtime.state.speedBytesPerSec !== speed) this.scheduleUpdate(runtime)
      this.refreshStuckConnections(runtime, now)
      this.reconcile(runtime)
      this.adjustStreams(runtime, runtime.concurrency?.tick(this.concurrencySnapshot(runtime, now)))
    }
    // The last blocks are in, or the run was stopped: its streams wind down.
    runtime.stop.abort()
    await Promise.all(runtime.workers.values())
    // Stopped partway through a step: streams it added were never judged, so they don't stay.
    if (runtime.state.status !== 'downloading') {
      this.adjustStreams(runtime, runtime.concurrency?.interrupt())
    }

    if (runtime.state.status !== 'downloading') {
      // Paused, errored, or cancelled — nothing left to do right now. An error keeps what it has
      // unless it can't be resumed (see failDownload); cancel() discards it.
      if (runtime.state.status === 'error') {
        this.pushUpdate(runtime)
        if (runtime.state.resumable === false) await runtime.file.discard()
      }
      return
    }

    runtime.publishing = true
    try {
      if (runtime.blocks.some((block) => block.status !== 'completed')) {
        throw new Error('Download is incomplete — refusing to publish the file')
      }
      await this.persistNow(runtime)
      const publishedPath = await runtime.file.publish(
        runtime.state.destinationPath,
        runtime.state.totalBytes,
        async (candidate) => {
          runtime.publicationPath = candidate
          const partial = await stat(runtime.file.path)
          runtime.publicationIdentity = { dev: partial.dev, ino: partial.ino }
          await this.persistNow(runtime, true)
        }
      )
      runtime.state.destinationPath = publishedPath
      runtime.state.fileName = basename(publishedPath)
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      runtime.state.bytesDownloaded = runtime.state.totalBytes || runtime.state.bytesDownloaded
      await this.persistNow(runtime)
      await runtime.file.discard().catch(() => {})
      this.notify('Download Complete', `${runtime.state.fileName} has finished downloading.`)
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      this.notify('Download Failed', `${runtime.state.fileName}: ${runtime.state.error}`)
    }
    runtime.publishing = false

    this.pushUpdate(runtime)
  }

  /** Stops the current run: every stream, and the run's own wait. */
  private stopRun(runtime: DownloadRuntime): void {
    runtime.stop.abort()
    for (const self of runtime.chunkRuntimes.values()) self.controller.abort()
  }

  /** Ends the download in an error. What it has downloaded stays for a resume, unless
   * `discard`: bytes that are no use any more. */
  private failDownload(runtime: DownloadRuntime, message: string, discard = false): void {
    if (runtime.state.status !== 'downloading') return
    runtime.state.status = 'error'
    runtime.state.error = message
    runtime.state.resumable = !discard
    this.notify('Download Failed', `${runtime.state.fileName}: ${message}`)
    this.stopRun(runtime)
  }

  /** The server keeps refusing requests over this network: it stops being used until the user
   * switches it off and on, it reconnects, or the download is resumed. */
  private failNetwork(runtime: DownloadRuntime, network: DownloadNetwork, message: string): void {
    network.status = 'failed'
    network.error = message
    this.reconcile(runtime)
  }

  private network(runtime: DownloadRuntime, id: string): DownloadNetwork {
    const network = runtime.state.networks.find((entry) => entry.id === id)
    if (!network) throw new Error(`Unknown network ${id}`)
    return network
  }

  /**
   * Brings the download's networks up to date with the computer's, and each network's streams in
   * line with what it can do now. Runs every tick and whenever something changes — a network
   * came or went, the user switched one, one stopped getting through — and is safe to run any
   * time.
   *
   * Networks: every one on the computer is listed; one that turns up mid-download starts off,
   * for the user to switch on. A network the download never used is dropped once it goes.
   *
   * Streams, while the download runs:
   * - A network that has just come into use (on) starts a set of them (see startingStreams);
   *   from there concurrency.ts sizes it.
   * - One that can't reach the server (unreachable) keeps a single stream trying, to find out
   *   when it can again.
   * - One that is off, offline or failed runs none. Retiring a stream costs nothing: what it
   *   wrote stays, and whoever takes its block next resumes from there.
   * A download that can't be split runs one stream, on the first network able to carry it.
   */
  private reconcile(runtime: DownloadRuntime): void {
    const { state } = runtime
    const present = this.networks.current
    // Until the monitor has looked, nothing is known to be gone.
    const known = present !== null
    if (known) {
      state.networks = state.networks.filter(
        (network) =>
          network.enabled ||
          network.bytesDownloaded > 0 ||
          present.some((iface) => iface.id === network.id) ||
          state.chunks.some((chunk) => chunk.interfaceId === network.id)
      )
      for (const iface of present) {
        if (!state.networks.some((network) => network.id === iface.id)) {
          state.networks.push(newNetwork(iface, false))
        }
      }
    }

    for (const network of state.networks) {
      const iface = this.networks.find(network.id)
      if (iface) {
        network.label = iface.displayName
        network.kind = iface.kind
      }
      const status: NetworkStatus = !network.enabled
        ? 'off'
        : !iface && known
          ? 'offline'
          : network.status === 'off' || network.status === 'offline'
            ? 'on'
            : network.status
      if (status !== network.status) {
        network.status = status
        network.error = undefined
      }
    }
    if (state.status !== 'downloading' || runtime.stop.signal.aborted) return

    const enabled = state.networks.filter((network) => network.enabled)
    if (enabled.length > 0 && enabled.every((network) => network.status === 'failed')) {
      this.failDownload(runtime, enabled[0].error ?? 'No network could reach the server')
      return
    }

    const canSplit = splittable(runtime.requestPayload)
    const usable = state.networks.filter(
      (network) => network.status === 'on' || network.status === 'unreachable'
    )
    const running = canSplit ? usable : usable.slice(0, 1)
    const joining = running.filter(
      (network) =>
        network.status === 'on' &&
        (runtime.reconciled.get(network.id) !== 'on' ||
          this.liveStreams(runtime, network.id).length === 0)
    )
    const starting = canSplit
      ? startingStreams(
          runtime.blocks.filter((block) => block.status === 'pending').length,
          joining.length,
          testStreamsPerNetwork() ?? undefined
        )
      : 1

    const now = Date.now()
    const toStart: ChunkState[] = []
    for (const network of state.networks) {
      const live = this.liveStreams(runtime, network.id)
      const target = !running.includes(network)
        ? 0
        : network.status === 'unreachable'
          ? 1
          : joining.includes(network)
            ? Math.max(live.length, starting)
            : live.length
      if (joining.includes(network)) this.traffic(runtime, network.id).aliveAt = now
      if (live.length > target) this.retireStreams(runtime, network.id, live.length - target)
      // Streams kept from before a pause start again.
      for (const chunk of live.slice(0, target)) {
        if (!runtime.workers.has(chunk.id)) toStart.push(chunk)
      }
      if (target > live.length) {
        toStart.push(...this.addStreams(runtime, network.id, target - live.length))
      }
      runtime.reconciled.set(network.id, network.status)
    }
    // Each stream claims a block the moment it starts, so every network gets its first before
    // any gets a second: a small file shouldn't all go to whichever network came first.
    this.startStreams(
      runtime,
      interleave(toStart, (chunk) => chunk.interfaceId)
    )
  }

  /** A network's streams that aren't on their way out. */
  private liveStreams(runtime: DownloadRuntime, networkId: string): ChunkState[] {
    return runtime.state.chunks.filter(
      (chunk) => chunk.interfaceId === networkId && !runtime.chunkRuntimes.get(chunk.id)?.retiring
    )
  }

  private traffic(
    runtime: DownloadRuntime,
    networkId: string
  ): { received: number; aliveAt: number } {
    let traffic = runtime.traffic.get(networkId)
    if (!traffic) runtime.traffic.set(networkId, (traffic = { received: 0, aliveAt: 0 }))
    return traffic
  }

  private startStreams(runtime: DownloadRuntime, chunks: ChunkState[]): void {
    for (const chunk of chunks) {
      runtime.workers.set(
        chunk.id,
        this.runWorker(runtime, chunk).finally(() => {
          runtime.workers.delete(chunk.id)
          if (runtime.chunkRuntimes.get(chunk.id)?.retiring) this.removeStream(runtime, chunk)
        })
      )
    }
    if (chunks.length > 0) this.scheduleUpdate(runtime)
  }

  private adjustStreams(runtime: DownloadRuntime, action: Action | undefined): void {
    if (action?.kind === 'add') {
      this.startStreams(runtime, this.addStreams(runtime, action.networkId, action.count))
    } else if (action?.kind === 'retire') {
      this.retireStreams(runtime, action.networkId, action.count)
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
  private refreshStuckConnections(runtime: DownloadRuntime, now: number): void {
    // Without ranges a reconnect restarts the whole file from byte 0.
    if (!runtime.requestPayload.supportsRanges) return

    let unreachable = false
    for (const chunk of runtime.state.chunks) {
      const self = runtime.chunkRuntimes.get(chunk.id)
      const attempt = self?.attempt
      if (!self || !attempt || attempt.abortReason) continue

      const silent = this.isSilent(runtime, attempt, now)
      // A refresh isn't a failure, so no failed request would say that the network can't get
      // through; a connection gone silent with the rest of its network says it instead, as soon
      // as SILENT_AFTER_MS rather than once a connect or stall timeout has run out.
      if (silent && this.markUnreachable(runtime, this.network(runtime, attempt.networkId), now)) {
        unreachable = true
      }

      const index = attempt.block.index
      const refreshes = runtime.refreshesByBlock.get(index) ?? 0
      // A hedge is optional work: it is only ever dropped, never counted against its block.
      const isPrimary = attempt.kind === 'primary'
      if (isPrimary && refreshes >= MAX_REFRESHES_PER_BLOCK) continue

      if (silent || (isPrimary && this.isCrawling(runtime, chunk, self, now))) {
        if (isPrimary) runtime.refreshesByBlock.set(index, refreshes + 1)
        this.abortAttempt(attempt, 'refresh')
      }
    }
    if (unreachable) this.reconcile(runtime)
  }

  /** Marks a network in use that has received nothing for SILENT_AFTER_MS as unable to reach the
   * server. Whether it did. */
  private markUnreachable(
    runtime: DownloadRuntime,
    network: DownloadNetwork,
    now: number
  ): boolean {
    if (network.status !== 'on') return false
    if (now - this.traffic(runtime, network.id).aliveAt < SILENT_AFTER_MS) return false
    network.status = 'unreachable'
    return true
  }

  private isSilent(runtime: DownloadRuntime, attempt: Attempt, now: number): boolean {
    if (attempt.networkReceived > 0 || now - attempt.startedAt < SILENT_AFTER_MS) return false
    // Until something has arrived, a quiet origin is just a slow one — nothing to blame this
    // connection for.
    return runtime.blocks.some(
      (block) => block.index !== attempt.block.index && block.bytesDownloaded > 0
    )
  }

  private isCrawling(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    now: number
  ): boolean {
    const warm = (connection: ChunkRuntime): boolean => now - connection.warmSince >= SLOW_WARMUP_MS
    if (!warm(self)) return false

    const reference: number[] = []
    for (const other of runtime.state.chunks) {
      if (other.interfaceId !== chunk.interfaceId) continue
      const peer = runtime.chunkRuntimes.get(other.id)
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

  private notify(title: string, body: string): void {
    if (testKnobs.userDataDir || !Notification.isSupported()) return
    try {
      const notification = new Notification({ title, body })
      notification.on('click', () => {
        const window = this.getWindow()
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
      })
      notification.show()
    } catch {
      // Best-effort notification
    }
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
  private otherAttemptsPosition(runtime: DownloadRuntime, attempt: Attempt): number {
    let furthest = 0
    for (const other of runtime.attempts.get(attempt.block.index) ?? []) {
      if (other !== attempt) furthest = Math.max(furthest, this.attemptPosition(other))
    }
    return furthest
  }

  /** The stream holds no block: it says so, rather than keeping the last one's numbers on show. */
  private goIdle(chunk: ChunkState): void {
    chunk.status = 'pending'
    chunk.currentBlockIndex = undefined
    chunk.hedge = undefined
    chunk.speedBytesPerSec = 0
  }

  private beginAttempt(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    work: Work
  ): Attempt {
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
      runtime.avoidNetworkByBlock.delete(block.index)
    } else {
      runtime.hedgesByBlock.set(block.index, (runtime.hedgesByBlock.get(block.index) ?? 0) + 1)
    }
    const inFlight = runtime.attempts.get(block.index)
    if (inFlight) inFlight.push(attempt)
    else runtime.attempts.set(block.index, [attempt])
    self.attempt = attempt

    chunk.status = 'downloading'
    chunk.hedge = work.kind === 'hedge' ? true : undefined
    chunk.rangeStart = block.rangeStart
    chunk.rangeEnd = block.rangeEnd
    chunk.currentBlockIndex = block.index
    return attempt
  }

  /** Takes the attempt off the books. Safe to repeat. */
  private endAttempt(runtime: DownloadRuntime, self: ChunkRuntime, attempt: Attempt): void {
    const inFlight = runtime.attempts.get(attempt.block.index)
    if (inFlight) {
      const position = inFlight.indexOf(attempt)
      if (position >= 0) inFlight.splice(position, 1)
      if (inFlight.length === 0) runtime.attempts.delete(attempt.block.index)
    }
    if (self.attempt === attempt) self.attempt = null
  }

  /** Sends the request and reports how it ended. Never throws. */
  private async executeAttempt(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt
  ): Promise<AttemptOutcome> {
    const { block } = attempt
    try {
      if (attempt.kind === 'primary') {
        // A failed range leaves its written prefix in the staging file. Without range support,
        // the server can only restart from byte zero.
        attempt.startOffset = runtime.requestPayload.supportsRanges ? block.bytesDownloaded : 0
        // What another attempt has already secured stays counted.
        const keep = Math.max(attempt.startOffset, this.otherAttemptsPosition(runtime, attempt))
        if (retractBlock(block, keep, attempt.previousWriter) > 0) this.recomputeAggregates(runtime)
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
        url: runtime.requestPayload.url,
        rangeStart: block.rangeStart + attempt.startOffset,
        rangeEnd: block.rangeEnd,
        connection: self.connection,
        createDestination: () => runtime.file.writer(block.rangeStart + (attempt.startOffset ?? 0)),
        signal: AbortSignal.any([self.controller.signal, attempt.abort.signal]),
        acceptedVersions: runtime.acceptedVersions,
        headers: runtime.requestPayload.headers,
        onResponse: (info) => (attempt.response = info),
        onNetworkProgress: (bytesThisRun) => {
          const delta = bytesThisRun - attempt.networkReceived
          if (delta > 0) {
            attempt.networkReceived = bytesThisRun
            attempt.lastNetworkAt = Date.now()
            this.onNetworkProgress(runtime, chunk, self, delta)
          }
        },
        onProgress: (bytesThisRun) => {
          const delta = bytesThisRun - attempt.received
          if (delta > 0) {
            attempt.received = bytesThisRun
            this.onAttemptProgress(runtime, chunk, attempt)
          }
        }
      })
      return { type: 'completed' }
    } catch (error) {
      const status = runtime.state.status as DownloadStatus
      if (self.controller.signal.aborted || status !== 'downloading') return { type: 'stopped' }
      if (attempt.abortReason) return { type: 'aborted', reason: attempt.abortReason }
      return { type: 'failed', error }
    }
  }

  private onNetworkProgress(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    deltaBytes: number
  ): void {
    const now = Date.now()
    self.receivedBytes += deltaBytes
    const traffic = this.traffic(runtime, chunk.interfaceId)
    traffic.received += deltaBytes
    traffic.aliveAt = now
    const network = this.network(runtime, chunk.interfaceId)
    if (network.status === 'unreachable') {
      // Through again: the next reconcile gives it back its streams.
      network.status = 'on'
      self.failures = 0
    }
    let samples = runtime.speedSamplesByChunk.get(chunk.id)
    if (!samples) {
      samples = []
      runtime.speedSamplesByChunk.set(chunk.id, samples)
    }
    chunk.speedBytesPerSec = pushSpeedSample(samples, self.receivedBytes, now)
    updateSpeeds(runtime, now)
    this.scheduleUpdate(runtime)
  }

  private onAttemptProgress(runtime: DownloadRuntime, chunk: ChunkState, attempt: Attempt): void {
    // Only what gets the block further than it already was counts as progress: a racing attempt
    // re-fetches bytes the other already has.
    const gained = advanceBlock(attempt.block, attempt.networkId, this.attemptPosition(attempt))
    chunk.bytesDownloaded += gained
    this.network(runtime, attempt.networkId).bytesDownloaded += gained

    // This runs on every completed writer callback, so it folds the delta in rather than re-summing
    // every block — that sum is O(blocks), and a large file has thousands of them. The other
    // callers of recomputeAggregates are rare enough to afford the full pass, and each one
    // re-derives the true total, so any drift here cannot accumulate.
    runtime.state.bytesDownloaded += gained
    this.scheduleUpdate(runtime)
  }

  /** Applies what became of an attempt to the download. 'stop' ends the stream. */
  private async finishAttempt(
    runtime: DownloadRuntime,
    chunk: ChunkState,
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
        return this.finishCompleted(runtime, chunk, self, attempt)
      case 'stopped':
        return this.finishStopped(runtime, chunk, self, attempt)
      case 'aborted':
        return this.finishAborted(runtime, chunk, self, attempt, outcome.reason)
      case 'failed':
        return this.finishFailed(runtime, chunk, self, attempt, outcome.error)
    }
  }

  private finishCompleted(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt
  ): 'continue' {
    const { block } = attempt

    // Another attempt already finished this block: these bytes are surplus.
    if (block.status === 'completed') {
      this.letGo(runtime, chunk, self, attempt, false)
      return 'continue'
    }

    this.endAttempt(runtime, self, attempt)
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
    for (const rival of runtime.attempts.get(block.index) ?? []) this.abortAttempt(rival, 'lost')
    this.recomputeAggregates(runtime)
    this.scheduleUpdate(runtime)
    return 'continue'
  }

  /** The stream was stopped while its request was in flight. */
  private finishStopped(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt
  ): 'stop' {
    // Whatever stopped it — a pause, a cancel, retirement — the block goes back as any other
    // attempt's would, and one another attempt has finished stays finished.
    this.letGo(runtime, chunk, self, attempt, false)
    chunk.status = runtime.state.status === 'paused' ? 'paused' : 'cancelled'
    return 'stop'
  }

  private async finishAborted(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt,
    reason: AbortReason
  ): Promise<'continue'> {
    // 'lost': another attempt decided the block, so its state is no longer this one's to touch.
    // 'refresh': not a failure — no retry counted, no backoff. Whoever takes the block next
    // resumes it from the staging file on a new connection.
    this.letGo(runtime, chunk, self, attempt, reason === 'refresh' && attempt.networkReceived === 0)
    if (reason === 'refresh' && attempt.kind === 'primary') {
      // A moment before this stream asks again, so that a connection already proven fast, if
      // there is one, gets to the block before this one does.
      this.scheduleUpdate(runtime)
      await delay(REFRESH_HANDOFF_MS, self.wait)
      self.warmSince = Date.now()
      self.slowSince = null
    }
    return 'continue'
  }

  private async finishFailed(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    const message = error instanceof Error ? error.message : String(error)
    const network = this.network(runtime, attempt.networkId)
    const deliveredNothing = attempt.networkReceived === 0

    if (error instanceof RemoteChangedError) {
      const verdict =
        error.check.kind === 'size'
          ? 'different'
          : await this.confirmSameBytes(runtime, self.connection, error.seen)
      // The check takes a moment; the download may have been paused or stopped meanwhile.
      if ((runtime.state.status as DownloadStatus) !== 'downloading') {
        return this.finishStopped(runtime, chunk, self, attempt)
      }
      if (verdict === 'same') {
        // Same bytes under another label — accept it and fetch again straight away; nothing from
        // the rejected response was written.
        if (compareVersion(runtime.acceptedVersions, error.seen).kind !== 'same') {
          runtime.acceptedVersions.push(error.seen)
        }
        this.letGo(runtime, chunk, self, attempt, false)
        return 'continue'
      }
      if (verdict === 'different') {
        // Every other worker would hit the same new version, so stop them all now rather than
        // let each burn through its retries first. What's on disk is of the old version: no use.
        this.failDownload(runtime, message, true)
        return this.finishStopped(runtime, chunk, self, attempt)
      }
      // 'unknown' — nothing to compare yet, or the check itself failed: retry like any other
      // failed request. Nothing wrong was written either way.
    }

    if (error instanceof NoCompatibleRouteError) {
      // A redirect can move this worker to a host its network cannot reach, and no retry over
      // it will change that. Its block goes back to the queue for another network.
      this.letGo(runtime, chunk, self, attempt, deliveredNothing)
      this.failNetwork(runtime, network, message)
      return 'stop'
    }

    // What the server's answer says about the network: a connection failing while the whole
    // network has gone quiet means the network can't reach the server — dropped, or connected
    // with no way through. It stops being used, bar one stream that keeps trying (see reconcile).
    if (error instanceof ConnectionError && this.markUnreachable(runtime, network, Date.now())) {
      this.reconcile(runtime)
    }

    // A hedge is optional work: its failure isn't retried, and what it did write stays.
    if (attempt.kind === 'hedge') {
      this.letGo(runtime, chunk, self, attempt, deliveredNothing)
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
    this.letGo(runtime, chunk, self, attempt, deliveredNothing)

    // A connection that failed is the network's doing, and is tried again for as long as the
    // network is there. A server that answered wrongly gets MAX_CHUNK_RETRIES in a row, and one
    // that answered busy is waited out for SERVER_BUSY_FOR_MS as well; then this stream gives up,
    // and once all its network's have, so does the network.
    const now = Date.now()
    const busy = error instanceof HttpStatusError && error.transient
    if (busy) self.busySince ??= now
    const waitingOut = busy && now - (self.busySince ?? now) < SERVER_BUSY_FOR_MS
    if (!(error instanceof ConnectionError) && ++self.strikes > MAX_CHUNK_RETRIES && !waitingOut) {
      self.retiring = true
      if (this.liveStreams(runtime, network.id).length === 0) {
        this.failNetwork(runtime, network, message)
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
      runtime.holdUntil.set(
        network.id,
        Math.max(runtime.holdUntil.get(network.id) ?? 0, now + asked)
      )
    }

    chunk.status = 'retrying'
    this.scheduleUpdate(runtime)
    await this.backOff(self, wait)
    const statusAfterDelay = runtime.state.status as DownloadStatus
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
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt,
    deliveredNothing: boolean
  ): void {
    this.endAttempt(runtime, self, attempt)
    const { block } = attempt
    // A block another attempt has finished stays finished.
    if (attempt.kind === 'primary' && block.status === 'downloading') block.status = 'pending'
    if (deliveredNothing) runtime.avoidNetworkByBlock.set(block.index, attempt.networkId)
    this.goIdle(chunk)
  }

  private concurrencySnapshot(runtime: DownloadRuntime, now: number): Snapshot {
    const inUse = runtime.state.networks.filter((network) => network.status === 'on')
    const networks = inUse.map(({ id }) => {
      let streams = 0
      let rejected = 0
      for (const chunk of this.liveStreams(runtime, id)) {
        const self = runtime.chunkRuntimes.get(chunk.id)
        streams++
        if (self && self.failures > 0 && self.receivedBytes === 0) rejected++
      }
      return { id, streams, rejected, received: this.traffic(runtime, id).received }
    })
    let retiring = 0
    for (const self of runtime.chunkRuntimes.values()) if (self.retiring) retiring++
    const waiting = runtime.blocks.filter((block) => block.status === 'pending').length
    // Two waiting blocks per new stream, so it neither idles nor strands a slow network's share.
    return { now, networks, spareWork: Math.floor(waiting / 2), retiring }
  }

  /** New streams on `networkId`, put on the download's list for the caller to start. */
  private addStreams(runtime: DownloadRuntime, networkId: string, count: number): ChunkState[] {
    let id = Math.max(-1, ...runtime.state.chunks.map((chunk) => chunk.id))
    const added = Array.from({ length: count }, () => newStream(++id, networkId))
    runtime.state.chunks.push(...added)
    runtime.state.peakStreams = Math.max(
      runtime.state.peakStreams ?? 0,
      runtime.state.chunks.length
    )
    debug('streams', { network: networkId, added: count })
    this.scheduleUpdate(runtime)
    return added
  }

  /** Stops the newest `count` streams on `networkId` for good. Stopping partway through a block
   * costs nothing: what it wrote stays, and whoever takes the block next resumes from there. */
  private retireStreams(runtime: DownloadRuntime, networkId: string, count: number): void {
    if (count < 1) return
    for (const chunk of this.liveStreams(runtime, networkId).slice(-count)) {
      const self = runtime.chunkRuntimes.get(chunk.id)
      if (self && runtime.workers.has(chunk.id)) {
        // Its worker takes it off the list once it has stopped.
        self.retiring = true
        self.controller.abort()
      } else {
        this.removeStream(runtime, chunk)
      }
    }
    debug('streams', { network: networkId, retired: count })
  }

  /** Takes a retired stream off the list. */
  private removeStream(runtime: DownloadRuntime, chunk: ChunkState): void {
    runtime.chunkRuntimes.delete(chunk.id)
    runtime.speedSamplesByChunk.delete(chunk.id)
    const index = runtime.state.chunks.indexOf(chunk)
    if (index < 0) return
    runtime.state.chunks.splice(index, 1)
    this.scheduleUpdate(runtime)
  }

  private async runWorker(runtime: DownloadRuntime, chunk: ChunkState): Promise<void> {
    const controller = new AbortController()
    const self: ChunkRuntime = {
      controller,
      wait: AbortSignal.any([controller.signal, runtime.stop.signal]),
      nudge: new AbortController(),
      connection: new StreamConnection(() => this.networks.find(chunk.interfaceId), {
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
      retiring: false
    }
    runtime.chunkRuntimes.set(chunk.id, self)

    try {
      while (runtime.state.status === 'downloading') {
        if (controller.signal.aborted || self.retiring) break

        // The server asked this network to hold off: no new request over it until then. Each
        // stream comes back a little apart from the others.
        const holdFor = (runtime.holdUntil.get(chunk.interfaceId) ?? 0) - Date.now()
        if (holdFor > 0) {
          this.goIdle(chunk)
          chunk.status = 'retrying'
          this.scheduleUpdate(runtime)
          await this.backOff(self, holdFor + Math.random() * Math.min(1000, holdFor / 10))
          continue
        }

        // Taken atomically: nothing between choosing the work and registering it can yield.
        const work = pickWork(
          {
            blocks: runtime.blocks,
            streams: runtime.state.chunks,
            attempts: runtime.attempts,
            avoid: runtime.avoidNetworkByBlock,
            hedgesUsed: runtime.hedgesByBlock
          },
          { id: chunk.id, networkId: chunk.interfaceId },
          Date.now(),
          SCHEDULER_POLICY
        )
        if (!work) {
          this.goIdle(chunk)
          // While blocks are still in flight, stay available in case one fails and is handed back,
          // or turns out to be slow enough to be worth racing.
          if (runtime.blocks.some((b) => b.status === 'pending' || b.status === 'downloading')) {
            this.scheduleUpdate(runtime)
            await delay(IDLE_POLL_MS, self.wait)
            continue
          }
          chunk.status = 'completed'
          this.scheduleUpdate(runtime)
          break
        }

        const attempt = this.beginAttempt(runtime, chunk, self, work)
        this.scheduleUpdate(runtime)
        const outcome = await this.executeAttempt(runtime, chunk, self, attempt)
        let next: 'continue' | 'stop'
        try {
          next = await this.finishAttempt(runtime, chunk, self, attempt, outcome)
        } finally {
          this.endAttempt(runtime, self, attempt)
        }
        if (next === 'stop') break
      }
    } finally {
      // Its sockets would otherwise stay open, kept alive for requests that will never come.
      self.connection.close()
    }

    this.scheduleUpdate(runtime)
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
    runtime: DownloadRuntime,
    connection: StreamConnection,
    seen: FileVersion
  ): Promise<'same' | 'different' | 'unknown'> {
    if (compareVersion(runtime.acceptedVersions, seen).kind === 'same') return 'same'

    // Every byte on disk came from an accepted version: mismatched responses are rejected
    // before anything is written.
    const withData = runtime.blocks.filter((block) => block.bytesDownloaded > 0)
    const step = Math.max(1, withData.length / MAX_SAMPLES)
    const picks = Array.from(
      { length: Math.min(MAX_SAMPLES, withData.length) },
      (_, i) => withData[Math.floor(i * step)]
    )

    let compared = 0
    for (const block of picks) {
      let local: Buffer
      try {
        local = await runtime.file.read(
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
            runtime.requestPayload.url,
            block.rangeStart,
            block.rangeStart + local.length - 1,
            connection,
            runtime.requestPayload.headers
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

  /** Re-derives the byte counts from the blocks: the download's, and each network's. */
  private recomputeAggregates(runtime: DownloadRuntime): void {
    let total = 0
    const byNetwork = new Map<string, number>()
    for (const block of runtime.blocks) {
      total += block.bytesDownloaded
      for (const [id, bytes] of Object.entries(block.bytesByInterface)) {
        byNetwork.set(id, (byNetwork.get(id) ?? 0) + bytes)
      }
    }
    runtime.state.bytesDownloaded = total
    for (const network of runtime.state.networks) {
      network.bytesDownloaded = byNetwork.get(network.id) ?? 0
    }
    updateSpeeds(runtime)
  }

  private scheduleUpdate(runtime: DownloadRuntime): void {
    if (runtime.pushScheduled) return
    runtime.pushScheduled = true
    setTimeout(() => {
      runtime.pushScheduled = false
      this.pushUpdate(runtime)
    }, UI_UPDATE_MS)
  }

  private pushUpdate(runtime: DownloadRuntime, persist = true): void {
    this.keepAwake()
    // A removed download can still be winding down (workers finishing, cleanup). Its updates
    // would put it back on screen after the renderer has already moved on.
    if (this.runtimes.get(runtime.state.id) !== runtime) return
    if (persist) this.schedulePersistence(runtime)
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (runtime.state.status === 'paused' || runtime.state.status === 'cancelled') {
      clearSpeeds(runtime.state)
    }
    window.webContents.send(IpcChannels.downloadUpdated, this.takeUpdate(runtime))
  }

  /** What the window hasn't been sent yet: the download's state, and the blocks that moved. */
  private takeUpdate(runtime: DownloadRuntime): DownloadUpdate {
    const { blocks: all, ...state } = runtime.state
    const sent = runtime.sentBlocks
    const blocks: BlockState[] = []
    for (const block of all ?? runtime.blocks) {
      const last = sent[block.index]
      // bytesByInterface only ever changes along with bytesDownloaded (see blockProgress.ts).
      if (
        last?.status === block.status &&
        last.interfaceId === block.interfaceId &&
        last.bytesDownloaded === block.bytesDownloaded
      ) {
        continue
      }
      sent[block.index] = {
        status: block.status,
        interfaceId: block.interfaceId,
        bytesDownloaded: block.bytesDownloaded
      }
      blocks.push(block)
    }
    return structuredClone({ seq: ++runtime.sentUpdates, state, blocks })
  }

  private schedulePersistence(runtime: DownloadRuntime): void {
    if (this.suspending || runtime.removed || runtime.persistenceTimer) return
    runtime.persistenceTimer = setTimeout(() => {
      runtime.persistenceTimer = undefined
      void this.persistNow(runtime)
    }, CHECKPOINT_INTERVAL_MS)
  }

  private persistNow(runtime: DownloadRuntime, required = false): Promise<void> {
    if (runtime.removed) return runtime.persistenceChain
    if (runtime.persistenceTimer) {
      clearTimeout(runtime.persistenceTimer)
      runtime.persistenceTimer = undefined
    }

    const operation = runtime.persistenceChain
      .catch(() => {})
      .then(async () => {
        if (runtime.removed) return
        const dir = this.downloadDir(runtime.state.id)
        const path = this.manifestPath(runtime.state.id)
        const temporaryPath = `${path}.tmp`
        const { blocks, ...state } = runtime.state
        const persistedPayload: Omit<StartDownloadRequest, 'headers'> = {
          ...runtime.requestPayload
        }
        delete (persistedPayload as { headers?: unknown }).headers
        const persisted: PersistedDownload = {
          version: 5,
          savedAt: Date.now(),
          state: structuredClone(state),
          ...saveBlocks(blocks ?? runtime.blocks),
          partialPath: runtime.file.path,
          publicationPath: runtime.publicationPath,
          publicationIdentity: runtime.publicationIdentity,
          requestPayload: persistedPayload,
          credentialsRequiredAfterRestart:
            runtime.credentialsRequiredAfterRestart ||
            Object.keys(runtime.requestPayload.headers ?? {}).some((name) =>
              /^(authorization|cookie)$/i.test(name)
            )
        }
        if (runtime.state.status === 'downloading' || runtime.state.status === 'paused') {
          await runtime.file.sync()
        }
        await ensureDirectory(dir)
        await writeFile(temporaryPath, JSON.stringify(persisted), 'utf-8')
        await rename(temporaryPath, path)
      })
    runtime.persistenceChain = operation.catch(() => {
      // Routine progress checkpoints are best-effort. Publication intent is required.
    })
    return required ? operation : runtime.persistenceChain
  }

  private async removePersistedDownload(
    runtime: DownloadRuntime,
    discardPartial = true
  ): Promise<void> {
    runtime.removed = true
    if (runtime.persistenceTimer) clearTimeout(runtime.persistenceTimer)
    await runtime.persistenceChain.catch(() => {})
    if (discardPartial) await runtime.file.discard().catch(() => {})
    await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
  }
}
