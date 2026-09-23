/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import type { BrowserWindow } from 'electron'
import { app, Notification } from 'electron'

const netCjs = require('node:net')
const origNetConnect = netCjs.connect
const dgramCjs = require('node:dgram')
const origCreateSocket = dgramCjs.createSocket
const netBindingStorage = new AsyncLocalStorage<string>()

netCjs.connect = function (...args: any[]) {
  const localAddress = netBindingStorage.getStore()
  if (localAddress && localAddress !== '0.0.0.0') {
    if (typeof args[0] === 'object' && args[0] !== null) {
      args[0] = { family: 4, ...args[0], localAddress }
    } else if (typeof args[0] === 'number') {
      args[0] = { family: 4, port: args[0], host: args[1], localAddress }
    } else {
      args[0] = { family: 4, localAddress }
    }
  }
  return origNetConnect.apply(netCjs, args)
}

dgramCjs.createSocket = function (...args: any[]) {
  const socket = origCreateSocket.apply(dgramCjs, args)
  const localAddress = netBindingStorage.getStore()
  if (localAddress && localAddress !== '0.0.0.0') {
    const origSend = socket.send
    let bound = false
    socket.send = function (...sendArgs: any[]) {
      if (!bound) {
        try {
          socket.bind({ address: localAddress })
          bound = true
        } catch {
          // ignore if already bound
        }
      }
      return origSend.apply(socket, sendArgs)
    }
  }
  return socket
}

import { IpcChannels } from '../../shared/ipc-channels'
import type {
  BlockState,
  ChunkState,
  DownloadState,
  DownloadStatus,
  NetworkInterfaceInfo,
  StartDownloadRequest,
  StartSimulatedDownloadRequest
} from '../../shared/types'
import { interleave, planDownload } from '../../shared/plan'
import { testKnobs } from '../testKnobs'
import { isMagnetUrl } from './probe'
import { advanceBlock, retractBlock } from './blockProgress'
import { downloadChunk, fetchRange, RemoteChangedError } from './chunkDownloader'
import { compareVersion, type FileVersion } from './fileVersion'
import {
  fileSize,
  hedgeFile,
  mergeHedge,
  partFile,
  reconcilePartFileSize,
  removeHedgeFiles
} from './partFiles'
import { ensureDirectoryExists, reserveDestinationPath } from './paths'
import { pickWork, type SchedulerPolicy, type Work } from './scheduler'
import {
  createSimSession,
  downloadChunkSimulated,
  getSimAssembleSpeed,
  isSimulatedUrl,
  unregisterSimSession
} from './simDownload'

/** Why an attempt was called off by the manager rather than by a pause or a failure. */
type AbortReason = 'refresh' | 'lost'

/**
 * One request for one block, by one stream. A block normally has a single (primary) attempt.
 * Near the end of a download a second (hedge) one may race it — see scheduler.ts — and then the
 * block is finished by whichever gets there first.
 */
interface Attempt {
  kind: 'primary' | 'hedge'
  block: BlockState
  streamId: number
  networkId: string
  /** Where the request begins, as an offset into the block. Null until it is known. */
  startOffset: number | null
  /** Bytes the request has delivered so far. */
  received: number
  /** When the request was sent. */
  startedAt: number
  /** Where it writes: the block's own part file, or for a hedge a file of its own. */
  file: string
  /** The network that last wrote the part file this attempt resumes — whose tail bytes a
   * truncation would discard. */
  previousWriter: string | undefined
  /** Aborts this request alone; ChunkRuntime.controller aborts the whole stream. */
  abort: AbortController
  abortReason: AbortReason | null
  /** Set once this attempt has been chosen to finish the block, so a near-simultaneous finisher
   * can tell it lost. */
  won: boolean
  /** What the server's answer cost, for diagnosing slow connections (see PLEXO_DEBUG). */
  response: { ttfbMs: number; reusedSocket: boolean } | null
  /** Resolves once the request is over and its file closed. */
  settled: Promise<void>
  settle: () => void
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
}

interface SpeedSample {
  bytes: number
  time: number
}

interface DownloadRuntime {
  state: DownloadState
  requestPayload: StartDownloadRequest
  activeInterfaces: NetworkInterfaceInfo[]
  chunkRuntimes: Map<number, ChunkRuntime>
  tempDir: string
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
}

interface PersistedDownload {
  version: 1
  savedAt: number
  state: DownloadState
  requestPayload: StartDownloadRequest
  activeInterfaces: NetworkInterfaceInfo[]
}

// Set PLEXO_DEBUG=1 to log every request's outcome, how long the server took to answer and
// whether it reused a warm connection — what it takes to tell one slow connection from a slow path.
const debug: (...args: unknown[]) => void = process.env['PLEXO_DEBUG']
  ? (...args) => console.debug('[plexo]', ...args)
  : () => {}

const PROGRESS_THROTTLE_MS = 200

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

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
}

// A single TCP stream can get stuck at a crawl (loss-collapsed congestion window, a bad CDN node
// or route) while its siblings on the same network run fine. It never goes silent, so the stall
// watchdog can't catch it; a fresh connection usually lands somewhere healthy. Only relative
// thresholds — nothing here knows how fast the network ought to be.
const SLOW_RATIO = 0.1
const SLOW_WARMUP_MS = testKnobs.slowWarmupMs
const SLOW_FOR_MS = testKnobs.slowForMs
// A connection that has received nothing this long, while the file is being served to others, is
// dead rather than slow (a network that isn't answering, a stuck handshake).
const SILENT_AFTER_MS = testKnobs.silentAfterMs
// Bounds every case where refreshing can't help (the whole network got slower, a stale
// reference): at worst a block pays for a couple of cheap reconnects, then is left alone.
const MAX_REFRESHES_PER_BLOCK = 2
const SCHEDULER_POLICY: SchedulerPolicy = {
  hedgeAfterMs: testKnobs.hedgeAfterMs,
  maxHedgesPerBlock: 2
}
// Idle connections look for work every 250 ms, so waiting a bit longer hands a refreshed block
// to a connection that is already proven fast, if there is one.
const REFRESH_HANDOFF_MS = 300

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Total live speed across a download's worker connections (bounded by MAX_CHUNKS, unlike blocks). */
function sumChunkSpeeds(runtime: DownloadRuntime, now = Date.now()): number {
  let total = 0
  for (const chunk of runtime.state.chunks) {
    if (chunk.status === 'downloading') {
      const samples = runtime.speedSamplesByChunk.get(chunk.id)
      chunk.speedBytesPerSec = calculateCurrentSpeed(samples, now)
    }
    total += chunk.speedBytesPerSec
  }
  return total
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

/** Plain, unabortable wait — used only to throttle a simulated download's assemble step to a
 * configured speed (see reassemble()). Assembling isn't cancellable, so there's nothing to race. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

/** Throws if there isn't room for the download — a full disk should fail upfront with a clear
 * reason, not partway through as a confusing ENOSPC write error. The part files and the assembled
 * file both exist until assembly finishes, so when they share a volume it needs room for both. */
async function ensureDiskSpace(
  destinationDir: string,
  partsRoot: string,
  requiredBytes: number
): Promise<void> {
  if (requiredBytes <= 0) return // unknown size — nothing to check against

  const [destination, parts] = await Promise.all([stat(destinationDir), stat(partsRoot)])
  const needs: [string, number][] =
    destination.dev === parts.dev
      ? [[destinationDir, requiredBytes * 2]]
      : [
          [destinationDir, requiredBytes],
          [partsRoot, requiredBytes]
        ]

  for (const [dir, bytes] of needs) {
    const stats = await statfs(dir)
    const availableBytes = stats.bavail * stats.bsize
    if (availableBytes < bytes) {
      throw new Error(
        `Not enough disk space: this download needs ${formatGigabytes(bytes)} (the file plus its temporary parts) but only ${formatGigabytes(availableBytes)} is free`
      )
    }
  }
}

function extractMagnetTrackers(magnetUrl: string): string[] {
  try {
    const parsed = new URL(magnetUrl.replace(/^magnet:\?/, 'http://dummy/?'))
    return parsed.searchParams.getAll('tr')
  } catch {
    return []
  }
}

export class DownloadManager {
  private runtimes = new Map<string, DownloadRuntime>()
  private readonly initialization: Promise<void>
  private suspending = false

  constructor(
    private getWindow: () => BrowserWindow | null,
    private getInterfaceById: (id: string) => NetworkInterfaceInfo | undefined,
    private refreshInterfaces: () => Promise<NetworkInterfaceInfo[]>
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
          if (persisted.version !== 1 || persisted.state.id !== id || !persisted.state.blocks)
            return

          const state = persisted.state
          const blocks = state.blocks
          if (!blocks) return
          // 'assembling' means every block was already 'completed' and only the reassembly step
          // was interrupted — resuming re-enters runChunksToCompletion with nothing left to
          // download, so it goes straight back into reassemble() rather than needing its own
          // restart path.
          if (state.status === 'downloading' || state.status === 'assembling') {
            state.status = 'paused'
            state.pausedAt = persisted.savedAt || Date.now()
            state.assembledBytes = 0
          }
          state.speedBytesPerSec = 0
          for (const chunk of state.chunks) {
            chunk.speedBytesPerSec = 0
            chunk.currentBlockIndex = undefined
            chunk.hedge = undefined
            if (
              chunk.status === 'downloading' ||
              chunk.status === 'retrying' ||
              chunk.status === 'pending'
            ) {
              chunk.status = 'paused'
            }
          }
          for (const block of blocks) {
            if (block.status === 'downloading') block.status = 'pending'
          }

          restored.push({
            state,
            requestPayload: persisted.requestPayload,
            activeInterfaces: persisted.activeInterfaces,
            chunkRuntimes: new Map(),
            tempDir: join(this.downloadDir(id), 'parts'),
            speedSamplesByChunk: new Map(),
            pushScheduled: false,
            blocks,
            totalBlocks: state.totalBlocks ?? blocks.length,
            persistenceChain: Promise.resolve(),
            removed: false,
            acceptedVersions: [requestedVersion(persisted.requestPayload)],
            refreshesByBlock: new Map(),
            avoidNetworkByBlock: new Map(),
            attempts: new Map(),
            hedgesByBlock: new Map()
          })
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

    await Promise.all(orphans.map((runtime) => this.removePersistedDownload(runtime)))

    if (current) {
      this.runtimes.set(current.state.id, current)
      await this.persistNow(current)
    }
  }

  async getCurrentDownload(): Promise<DownloadState | null> {
    await this.initialization
    const latest = [...this.runtimes.values()].sort(
      (a, b) => b.state.startedAt - a.state.startedAt
    )[0]
    return latest ? structuredClone(latest.state) : null
  }

  /** Plexo shows one download at a time (see useAppStore's currentDownload) — starting a second
   * one while one is already running/paused/assembling would silently race it for disk I/O and
   * scramble the renderer's single-download view as updates from both interleave. */
  private hasActiveDownload(): boolean {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'assembling'
      ) {
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

    const interfaces = requestPayload.interfaceIds
      .map((interfaceId) => this.getInterfaceById(interfaceId))
      .filter((iface): iface is NetworkInterfaceInfo => Boolean(iface))

    if (interfaces.length === 0) {
      throw new Error('Select at least one network interface')
    }

    return this.startWithInterfaces(requestPayload, interfaces)
  }

  /**
   * Dev-tool entry point: "downloads" a file that's already on disk through the exact same
   * pipeline a real download uses — chunking, the block grid, pause/resume, retries, the
   * assembling phase, reassembly — so every feature can be exercised on demand instead of needing
   * a real multi-network setup and a slow, flaky remote server to provoke retries and errors.
   * Only `chunkDownloader`'s HTTP transfer is swapped out (see simDownload.ts); everything else
   * in DownloadManager is unaware this isn't a real network transfer.
   */
  async startSimulated(payload: StartSimulatedDownloadRequest): Promise<string> {
    await this.initialization
    if (this.hasActiveDownload()) {
      throw new Error('A download is already in progress — finish or remove it first.')
    }
    if (payload.networks.length === 0) {
      throw new Error('Select at least one simulated network')
    }

    const { url, interfaces, totalBytes } = await createSimSession(
      payload.sourceFilePath,
      payload.networks,
      payload.assembleSpeedBytesPerSec || null
    )

    const requestPayload: StartDownloadRequest = {
      url,
      destinationDir: payload.destinationDir,
      suggestedFileName: basename(payload.sourceFilePath),
      totalBytes,
      supportsRanges: true,
      interfaceIds: interfaces.map((iface) => iface.id),
      chunkCount: payload.chunkCount,
      connectionsPerNetwork: payload.connectionsPerNetwork,
      etag: null,
      lastModified: null
    }

    return this.startWithInterfaces(requestPayload, interfaces)
  }

  private async startWithInterfaces(
    requestPayload: StartDownloadRequest,
    interfaces: NetworkInterfaceInfo[]
  ): Promise<string> {
    await mkdir(this.downloadsRoot(), { recursive: true })
    await ensureDirectoryExists(requestPayload.destinationDir)
    await ensureDiskSpace(
      requestPayload.destinationDir,
      this.downloadsRoot(),
      requestPayload.totalBytes
    )

    // Claimed on disk, not just picked, so a second download of the same file
    // name can't pick it too and overwrite this one at reassembly time. Done
    // before anything else is created, so a destination we can't write to
    // leaves nothing behind.
    const destinationPath = await reserveDestinationPath(
      requestPayload.destinationDir,
      requestPayload.suggestedFileName
    )

    const id = randomUUID()
    const tempDir = join(this.downloadDir(id), 'parts')
    try {
      await mkdir(tempDir, { recursive: true })
    } catch (error) {
      await rm(destinationPath, { force: true })
      throw error
    }

    const plan = planDownload({
      totalBytes: requestPayload.totalBytes,
      splittable: requestPayload.supportsRanges,
      networkCount: interfaces.length,
      streamsPerNetwork:
        requestPayload.connectionsPerNetwork ??
        Math.round(requestPayload.chunkCount / interfaces.length),
      maxBlockBytes: testKnobs.blockBytes // 8 MB outside tests
    })

    // The UI caps how many cells it renders separately (see BlockGrid), by bucketing these
    // blocks rather than by shrinking their count here.
    const blocks: BlockState[] = []
    if (requestPayload.totalBytes > 0) {
      const { blockSizeBytes } = plan
      for (
        let rangeStart = 0;
        rangeStart < requestPayload.totalBytes;
        rangeStart += blockSizeBytes
      ) {
        blocks.push({
          index: blocks.length,
          rangeStart,
          rangeEnd: Math.min(rangeStart + blockSizeBytes, requestPayload.totalBytes) - 1,
          status: 'pending',
          bytesDownloaded: 0,
          bytesByInterface: {}
        })
      }
    } else {
      // Size unknown: one open-ended block, to end of file.
      blocks.push({
        index: 0,
        rangeStart: 0,
        rangeEnd: null,
        status: 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {}
      })
    }

    const chunks: ChunkState[] = plan.streamNetworks.map((networkIndex, id) => {
      const iface = interfaces[networkIndex]
      return {
        id,
        interfaceId: iface.id,
        interfaceLabel: iface.displayName,
        interfaceKind: iface.kind,
        rangeStart: 0,
        rangeEnd: null,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'pending',
        retryCount: 0
      }
    })
    const activeInterfaces = [...new Set(plan.streamNetworks)].map((index) => interfaces[index])

    const state: DownloadState = {
      id,
      url: requestPayload.url,
      fileName: basename(destinationPath),
      destinationPath,
      totalBytes: requestPayload.totalBytes,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'downloading',
      chunks,
      blocks,
      totalBlocks: blocks.length,
      blockSizeBytes: plan.blockSizeBytes,
      startedAt: Date.now()
    }

    const runtime: DownloadRuntime = {
      state,
      requestPayload,
      activeInterfaces,
      chunkRuntimes: new Map(),
      tempDir,
      speedSamplesByChunk: new Map(),
      pushScheduled: false,
      blocks,
      totalBlocks: blocks.length,
      persistenceChain: Promise.resolve(),
      removed: false,
      acceptedVersions: [requestedVersion(requestPayload)],
      refreshesByBlock: new Map(),
      avoidNetworkByBlock: new Map(),
      attempts: new Map(),
      hedgesByBlock: new Map()
    }
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)

    void this.runChunksToCompletion(runtime, runtime.state.chunks)

    return id
  }

  async pause(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'downloading') return

    if ((runtime as any).magnetClients) {
      const clientsList = (runtime as any).magnetClients
      if (Array.isArray(clientsList)) {
        for (const item of clientsList) {
          try {
            item.client?.destroy()
          } catch {
            // ignore
          }
        }
      }
      ;(runtime as any).magnetClients = null
    }

    runtime.state.status = 'paused'
    runtime.state.speedBytesPerSec = 0
    runtime.state.pausedAt = Date.now()
    for (const chunk of runtime.state.chunks) {
      if (chunk.status !== 'completed') {
        chunk.status = 'paused'
      }
      chunk.speedBytesPerSec = 0
      chunk.currentBlockIndex = undefined
    }
    for (const block of runtime.blocks) {
      if (block.status === 'downloading') {
        block.status = 'pending'
      }
    }
    runtime.avoidNetworkByBlock.clear()
    // A hedge's file is discarded, so its progress must not be in the saved manifest.
    for (const attempts of runtime.attempts.values()) {
      for (const hedge of attempts) {
        const chunk = runtime.state.chunks.find((entry) => entry.id === hedge.streamId)
        if (hedge.kind === 'hedge' && chunk) this.retractHedge(runtime, chunk, hedge)
      }
    }
    for (const chunk of runtime.state.chunks) chunk.hedge = undefined
    for (const chunkRuntime of runtime.chunkRuntimes.values()) {
      chunkRuntime.controller.abort()
    }
    this.pushUpdate(runtime)
    await this.persistNow(runtime)
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || (runtime.state.status !== 'paused' && runtime.state.status !== 'error')) return

    void this.resumeAfterVerifying(runtime)
  }

  // A file that changed on the server while this download was paused is caught by the first
  // chunk request after resuming: its response is checked against the version the download
  // started on (see runWorker), which can tell a real change from a relabelled server.
  private async resumeAfterVerifying(runtime: DownloadRuntime): Promise<void> {
    const { url } = runtime.requestPayload

    if (isMagnetUrl(url)) {
      runtime.state.status = 'downloading'
      runtime.state.error = undefined
      this.pushUpdate(runtime)
      void this.runMagnetDownload(runtime)
      return
    }

    let availableInterfaces: NetworkInterfaceInfo[]
    if (isSimulatedUrl(url)) {
      // Synthetic sim interfaces aren't real NICs the OS enumerates — they never "disconnect",
      // so the ones already on the runtime are still exactly right.
      availableInterfaces = runtime.activeInterfaces
    } else {
      try {
        availableInterfaces = await this.refreshInterfaces()
      } catch {
        runtime.state.error = 'Could not refresh network interfaces. Try resuming again.'
        this.pushUpdate(runtime)
        return
      }
    }
    if (runtime.state.status !== 'paused' && runtime.state.status !== 'error') return

    const selectedIds = new Set(runtime.requestPayload.interfaceIds)
    runtime.activeInterfaces = availableInterfaces.filter((iface) => selectedIds.has(iface.id))
    if (runtime.activeInterfaces.length === 0) {
      runtime.state.error =
        'None of the networks selected for this download are currently available. Reconnect one and try again.'
      this.pushUpdate(runtime)
      return
    }

    // The part files are the real record of what's downloaded, not the manifest. If one went
    // missing or came up short while paused (userData cleaned out, a crash before a write hit
    // the disk), fetch that block again instead of failing at assembly.
    await mkdir(runtime.tempDir, { recursive: true })
    await removeHedgeFiles(runtime.tempDir)
    await Promise.all(
      runtime.blocks.map(async (block) => {
        if (block.status !== 'completed' || block.rangeEnd === null) return
        const size = await stat(partFile(runtime.tempDir, block.index)).then(
          (stats) => stats.size,
          () => -1
        )
        if (size !== block.rangeEnd - block.rangeStart + 1) block.status = 'pending'
      })
    )
    if (runtime.state.status !== 'paused' && runtime.state.status !== 'error') return

    for (let index = 0; index < runtime.state.chunks.length; index++) {
      const chunk = runtime.state.chunks[index]
      const iface =
        runtime.activeInterfaces.find((entry) => entry.id === chunk.interfaceId) ??
        runtime.activeInterfaces[index % runtime.activeInterfaces.length]
      chunk.interfaceId = iface.id
      chunk.interfaceLabel = iface.displayName
      chunk.interfaceKind = iface.kind
    }

    runtime.state.status = 'downloading'
    runtime.state.error = undefined
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

    // Streams start in the order given, and each claims a block on the spot: interleaved, so a
    // paused download saved before that was the rule can't hand every block to one network.
    const pending = runtime.state.chunks.filter((chunk) => chunk.status !== 'completed')
    const toRun = pending.length > 0 ? pending : runtime.state.chunks
    void this.runChunksToCompletion(
      runtime,
      interleave(toRun, (chunk) => chunk.interfaceId)
    )
  }

  cancel(id: string): void {
    const runtime = this.runtimes.get(id)
    if (
      !runtime ||
      (runtime.state.status !== 'downloading' &&
        runtime.state.status !== 'paused' &&
        runtime.state.status !== 'error')
    )
      return

    if ((runtime as any).magnetClients) {
      const clientsList = (runtime as any).magnetClients
      if (Array.isArray(clientsList)) {
        for (const item of clientsList) {
          try {
            item.client?.destroy()
          } catch {
            // ignore
          }
        }
      }
      ;(runtime as any).magnetClients = null
    }

    runtime.state.status = 'cancelled'
    runtime.state.speedBytesPerSec = 0
    for (const chunk of runtime.state.chunks) {
      chunk.speedBytesPerSec = 0
      chunk.status = 'cancelled'
    }
    for (const chunkRuntime of runtime.chunkRuntimes.values()) {
      chunkRuntime.controller.abort()
    }
    this.pushUpdate(runtime, false)
    void this.cleanupTempDir(runtime).catch(() => {})
    void this.discardUnfinishedDestination(runtime).catch(() => {})
    void this.removePersistedDownload(runtime).catch(() => {})
  }

  remove(id: string): void {
    const runtime = this.runtimes.get(id)
    if (
      runtime &&
      (runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'error')
    ) {
      this.cancel(id)
    }
    this.runtimes.delete(id)
    if (runtime) void this.removePersistedDownload(runtime).catch(() => {})
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

  private async runMagnetDownload(runtime: DownloadRuntime): Promise<void> {
    const { url, destinationDir } = runtime.requestPayload

    try {
      const WebTorrentMod = await import('webtorrent')
      const WebTorrent = WebTorrentMod.default || WebTorrentMod

      const magnetTrackers = extractMagnetTrackers(url)

      // Remove 0-byte placeholder reserved at start so WebTorrent can create file/folder without EEXIST collision
      try {
        await rm(runtime.state.destinationPath, { force: true })
      } catch {
        // ignore
      }

      for (const chunk of runtime.state.chunks) {
        chunk.status = 'downloading'
      }
      this.pushUpdate(runtime)

      const interfacesToUse =
        runtime.activeInterfaces.length > 0
          ? runtime.activeInterfaces
          : [{ id: 'default', address: '0.0.0.0', displayName: 'Default' } as any]

      const clientsInfo: {
        interfaceId: string
        iface: NetworkInterfaceInfo
        client: any
        torrent: any
        downloadSpeed: number
        downloaded: number
        done: boolean
      }[] = []

      ;(runtime as any).magnetClients = clientsInfo

      // Instantiate WebTorrent client per active interface
      for (const iface of interfacesToUse) {
        let client: any = null
        netBindingStorage.run(iface.address, () => {
          client = new WebTorrent({ maxConns: 55 })
        })

        const info = {
          interfaceId: iface.id,
          iface,
          client,
          torrent: null as any,
          downloadSpeed: 0,
          downloaded: 0,
          done: false
        }
        clientsInfo.push(info)

        client.on('error', (err: any) => {
          if (runtime.state.status === 'downloading' && clientsInfo.length === 1) {
            runtime.state.status = 'error'
            runtime.state.error = err?.message || 'BitTorrent client error'
            this.pushUpdate(runtime)
          }
        })
      }

      let sharedTorrentFile: Buffer | null = null

      const setupTorrentEvents = (info: (typeof clientsInfo)[0], torrent: any) => {
        info.torrent = torrent
        const iface = info.iface

        const announceList = [...new Set([...magnetTrackers, ...(torrent.announce || [])])]

        // Capture raw .torrent buffer so lagging interfaces bypass tracker metadata lookup instantly
        if (torrent.torrentFile && !sharedTorrentFile) {
          const torrentBuf: Buffer = torrent.torrentFile
          sharedTorrentFile = torrentBuf
          for (const item of clientsInfo) {
            if (item.client !== info.client && !item.torrent) {
              try {
                if (item.client.torrents && item.client.torrents.length > 0) {
                  item.client.remove(item.client.torrents[0])
                }
              } catch {
                // ignore
              }
              netBindingStorage.run(item.iface.address, () => {
                item.client.add(
                  torrentBuf,
                  { path: destinationDir, announce: announceList },
                  (t: any) => {
                    setupTorrentEvents(item, t)
                  }
                )
              })
            }
          }
        }

        if (typeof torrent.throttleUpload === 'function') {
          torrent.throttleUpload(15 * 1024)
        }

        if (torrent.length && (!runtime.state.totalBytes || runtime.state.totalBytes === 0)) {
          runtime.state.totalBytes = torrent.length
        }
        if (torrent.name && (!runtime.state.fileName || runtime.state.fileName === 'download')) {
          runtime.state.fileName = torrent.name
        }

        const configurePieceSelection = () => {
          if (!torrent || !torrent.pieces || torrent.pieces.length === 0) return
          const numPieces = torrent.pieces.length
          const totalClients = clientsInfo.length
          const clientIndex = clientsInfo.findIndex((item) => item.client === info.client)

          if (totalClients > 1 && clientIndex !== -1) {
            const startPiece = Math.floor((clientIndex * numPieces) / totalClients)
            const endPiece =
              clientIndex === totalClients - 1
                ? numPieces - 1
                : Math.floor(((clientIndex + 1) * numPieces) / totalClients) - 1

            if (typeof torrent.select === 'function') {
              // Enable all pieces at standard priority (1) so fast interfaces never starve when their partition is finished
              torrent.select(0, numPieces - 1, 1)
              // Elevate primary assigned partition to high priority (2)
              if (startPiece <= endPiece) {
                torrent.select(startPiece, endPiece, 2)
              }
            }
          }
        }

        if (torrent.pieces && torrent.pieces.length > 0) {
          configurePieceSelection()
        } else if (typeof torrent.on === 'function') {
          torrent.on('ready', () => {
            configurePieceSelection()
          })
        }

        torrent.on('download', () => {
          if (runtime.state.status !== 'downloading') return
          info.downloadSpeed = torrent.downloadSpeed
          info.downloaded = torrent.downloaded

          // Update chunk speeds & downloaded bytes for this interface's specific chunks
          const ifaceChunks = runtime.state.chunks.filter((c) => c.interfaceId === iface.id)
          const chunkCount = ifaceChunks.length || 1
          const perChunkSpeed = Math.round(torrent.downloadSpeed / chunkCount)
          const perChunkDownloaded = Math.round(torrent.downloaded / chunkCount)

          for (const chunk of ifaceChunks) {
            chunk.status = 'downloading'
            chunk.speedBytesPerSec = perChunkSpeed
            chunk.bytesDownloaded = perChunkDownloaded
          }

          // Calculate aggregate download speed & downloaded bytes across all bound clients
          const totalSpeed = clientsInfo.reduce((sum, item) => sum + item.downloadSpeed, 0)
          const totalDownloaded = clientsInfo.reduce((sum, item) => sum + item.downloaded, 0)
          const maxBytes = runtime.state.totalBytes || totalDownloaded

          runtime.state.speedBytesPerSec = totalSpeed
          runtime.state.bytesDownloaded = Math.min(maxBytes, totalDownloaded)

          if (runtime.blocks.length > 0 && maxBytes > 0) {
            const ratio = Math.min(1, totalDownloaded / maxBytes)
            const completedBlocks = Math.floor(ratio * runtime.blocks.length)

            for (let i = 0; i < runtime.blocks.length; i++) {
              const block = runtime.blocks[i]
              const bSize = block.rangeEnd ? block.rangeEnd - block.rangeStart + 1 : 0

              block.bytesByInterface[iface.id] = Math.min(bSize, info.downloaded)

              if (i < completedBlocks) {
                block.status = 'completed'
                block.bytesDownloaded = bSize
              } else if (i === completedBlocks) {
                block.status = 'downloading'
                block.bytesDownloaded = Math.round(
                  (ratio * runtime.blocks.length - completedBlocks) * bSize
                )
              }
            }
          }
          this.scheduleUpdate(runtime)
        })

        torrent.on('done', () => {
          info.done = true
          info.downloadSpeed = 0
          info.downloaded = torrent.length || torrent.downloaded

          const allDone = clientsInfo.every(
            (item) => item.done || (item.torrent && item.torrent.progress === 1)
          )

          if (allDone || torrent.progress === 1) {
            const finalBytes = runtime.state.totalBytes || torrent.length || torrent.downloaded
            runtime.state.bytesDownloaded = finalBytes
            runtime.state.speedBytesPerSec = 0
            runtime.state.status = 'completed'

            for (const block of runtime.blocks) {
              block.status = 'completed'
              const bSize = block.rangeEnd ? block.rangeEnd - block.rangeStart + 1 : 0
              block.bytesDownloaded = bSize
            }
            for (const chunk of runtime.state.chunks) {
              chunk.status = 'completed'
              chunk.speedBytesPerSec = 0
            }
            this.pushUpdate(runtime)
            void this.persistNow(runtime)

            for (const item of clientsInfo) {
              try {
                item.client?.destroy()
              } catch {
                // ignore
              }
            }
            ;(runtime as any).magnetClients = null
          }
        })

        torrent.on('error', (err: any) => {
          if (clientsInfo.every((item) => !item.torrent || item.torrent.destroyed)) {
            runtime.state.status = 'error'
            runtime.state.error = err?.message || 'Magnet transfer error'
            this.pushUpdate(runtime)
          }
        })
      }

      // Add magnet URL to all clients concurrently
      for (const info of clientsInfo) {
        netBindingStorage.run(info.iface.address, () => {
          info.client.add(
            url,
            { path: destinationDir, announce: magnetTrackers },
            (torrent: any) => {
              setupTorrentEvents(info, torrent)
            }
          )
        })
      }
    } catch (err: any) {
      runtime.state.status = 'error'
      runtime.state.error = err?.message || 'Failed to initialize BitTorrent client'
      this.pushUpdate(runtime)
    }
  }

  /** Runs (or resumes) fixed worker streams in parallel, leasing blocks until all are completed. */
  private async runChunksToCompletion(
    runtime: DownloadRuntime,
    chunks: ChunkState[]
  ): Promise<void> {
    if (isMagnetUrl(runtime.requestPayload.url)) {
      return this.runMagnetDownload(runtime)
    }
    const active = new Map<number, Promise<number>>()
    for (const chunk of chunks) {
      active.set(
        chunk.id,
        this.runWorker(runtime, chunk).then(() => chunk.id)
      )
    }

    const speedTicker = setInterval(() => {
      // Only the `finally` below stops this ticker — self-clearing on status here would let a
      // fast pause/resume start a second runChunksToCompletion (and ticker) while this one is
      // still winding down, and it would never see 'downloading' flip back on its own.
      if (runtime.state.status !== 'downloading') return
      const now = Date.now()
      const prevSpeed = runtime.state.speedBytesPerSec
      const newSpeed = sumChunkSpeeds(runtime, now)
      if (newSpeed !== prevSpeed) {
        runtime.state.speedBytesPerSec = newSpeed
        this.scheduleUpdate(runtime)
      }
      this.refreshStuckConnections(runtime, now)
    }, 500)
    speedTicker.unref()

    try {
      while (active.size > 0) {
        const finishedId = await Promise.race(active.values())
        active.delete(finishedId)
      }
    } finally {
      clearInterval(speedTicker)
    }

    if (runtime.state.status !== 'downloading') {
      // Paused, errored, or cancelled — nothing left to do right now.
      if (runtime.state.status === 'error' || runtime.state.status === 'cancelled') {
        this.pushUpdate(runtime)
        await this.cleanupTempDir(runtime)
        await this.discardUnfinishedDestination(runtime)
      }
      return
    }

    runtime.state.status = 'assembling'
    runtime.state.assembledBytes = 0
    runtime.state.speedBytesPerSec = 0
    this.pushUpdate(runtime)

    try {
      await this.reassemble(runtime)
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      runtime.state.bytesDownloaded = runtime.state.totalBytes || runtime.state.bytesDownloaded
      this.notify('Download Complete', `${runtime.state.fileName} has finished downloading.`)
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      this.notify('Download Failed', `${runtime.state.fileName}: ${runtime.state.error}`)
    }

    this.pushUpdate(runtime)
    await this.cleanupTempDir(runtime)
    await this.discardUnfinishedDestination(runtime)
  }

  /**
   * Reconnects a connection that isn't carrying its weight. Reconnecting is cheap — the block
   * resumes from its part file — and a fresh connection usually lands somewhere healthy.
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

    for (const chunk of runtime.state.chunks) {
      const self = runtime.chunkRuntimes.get(chunk.id)
      const attempt = self?.attempt
      if (!self || !attempt || attempt.abortReason) continue

      const index = attempt.block.index
      const refreshes = runtime.refreshesByBlock.get(index) ?? 0
      // A hedge is optional work: it is only ever dropped, never counted against its block.
      const isPrimary = attempt.kind === 'primary'
      if (isPrimary && refreshes >= MAX_REFRESHES_PER_BLOCK) continue

      if (
        this.isSilent(runtime, attempt, now) ||
        (isPrimary && this.isCrawling(runtime, chunk, self, now))
      ) {
        if (isPrimary) runtime.refreshesByBlock.set(index, refreshes + 1)
        this.abortAttempt(attempt, 'refresh')
      }
    }
  }

  private isSilent(runtime: DownloadRuntime, attempt: Attempt, now: number): boolean {
    if (attempt.received > 0 || now - attempt.startedAt < SILENT_AFTER_MS) return false
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
    iface: NetworkInterfaceInfo,
    work: Work
  ): Attempt {
    const { block } = work
    let settle!: () => void
    const settled = new Promise<void>((resolve) => (settle = resolve))
    const attempt: Attempt = {
      kind: work.kind,
      block,
      streamId: chunk.id,
      networkId: iface.id,
      startOffset: null,
      received: 0,
      startedAt: Date.now(),
      file:
        work.kind === 'primary'
          ? partFile(runtime.tempDir, block.index)
          : hedgeFile(runtime.tempDir, block.index, chunk.id),
      // Whoever held this block before now is the one whose tail bytes a truncation would
      // discard — captured before the lease overwrites the field.
      previousWriter: block.interfaceId,
      abort: new AbortController(),
      abortReason: null,
      won: false,
      response: null,
      settled,
      settle
    }

    if (work.kind === 'primary') {
      block.status = 'downloading'
      block.interfaceId = iface.id
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
    iface: NetworkInterfaceInfo,
    attempt: Attempt
  ): Promise<AttemptOutcome> {
    const { block } = attempt
    try {
      if (attempt.kind === 'primary') {
        // Without range support the server can only send the file from the start, so a retry or
        // resume begins again at byte 0 rather than asking for a Range it will ignore.
        const resumeOffset = await reconcilePartFileSize(
          attempt.file,
          runtime.requestPayload.supportsRanges ? block.bytesDownloaded : 0
        )
        attempt.startOffset = resumeOffset
        // What another attempt has already secured stays counted.
        const keep = Math.max(resumeOffset, this.otherAttemptsPosition(runtime, attempt))
        if (retractBlock(block, keep, attempt.previousWriter) > 0) this.recomputeAggregates(runtime)
      } else {
        // The block's file only ever grows, so what is on disk now is a prefix it will still
        // hold once its writer has stopped — the point this attempt picks up from.
        attempt.startOffset = await fileSize(partFile(runtime.tempDir, block.index))
      }

      const length = block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1
      if (length !== null && attempt.startOffset >= length) {
        // The part file already holds the whole block.
        return attempt.kind === 'primary'
          ? { type: 'completed' }
          : { type: 'aborted', reason: 'lost' }
      }

      attempt.startedAt = Date.now()
      const runDownload = isSimulatedUrl(runtime.requestPayload.url)
        ? downloadChunkSimulated
        : downloadChunk
      await runDownload({
        url: runtime.requestPayload.url,
        rangeStart: block.rangeStart + attempt.startOffset,
        rangeEnd: block.rangeEnd,
        localAddress: iface.address,
        destinationPath: attempt.file,
        append: attempt.kind === 'primary' && attempt.startOffset > 0,
        signal: AbortSignal.any([self.controller.signal, attempt.abort.signal]),
        acceptedVersions: runtime.acceptedVersions,
        onResponse: (info) => (attempt.response = info),
        onProgress: (bytesThisRun) => {
          const delta = bytesThisRun - attempt.received
          if (delta > 0) {
            attempt.received = bytesThisRun
            this.onAttemptProgress(runtime, chunk, self, attempt, delta)
          }
        }
      })
      return { type: 'completed' }
    } catch (error) {
      const status = runtime.state.status as DownloadStatus
      if (self.controller.signal.aborted || status !== 'downloading') return { type: 'stopped' }
      if (attempt.abortReason) return { type: 'aborted', reason: attempt.abortReason }
      return { type: 'failed', error }
    } finally {
      attempt.settle()
    }
  }

  private onAttemptProgress(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt,
    deltaBytes: number
  ): void {
    const now = Date.now()
    self.receivedBytes += deltaBytes
    let samples = runtime.speedSamplesByChunk.get(chunk.id)
    if (!samples) {
      samples = []
      runtime.speedSamplesByChunk.set(chunk.id, samples)
    }
    chunk.speedBytesPerSec = pushSpeedSample(samples, self.receivedBytes, now)

    // Only what gets the block further than it already was counts as progress: a racing attempt
    // re-fetches bytes the other already has.
    const gained = advanceBlock(attempt.block, attempt.networkId, this.attemptPosition(attempt))
    chunk.bytesDownloaded += gained

    // This runs on every socket data event, so it folds the delta in rather than re-summing
    // every block — that sum is O(blocks), and a large file has thousands of them. The other
    // callers of recomputeAggregates are rare enough to afford the full pass, and each one
    // re-derives the true total, so any drift here cannot accumulate.
    runtime.state.bytesDownloaded += gained
    runtime.state.speedBytesPerSec = sumChunkSpeeds(runtime)
    this.scheduleUpdate(runtime)
  }

  /** Applies what became of an attempt to the download. 'stop' ends the stream. */
  private async finishAttempt(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    iface: NetworkInterfaceInfo,
    attempt: Attempt,
    outcome: AttemptOutcome
  ): Promise<'continue' | 'stop'> {
    debug('attempt', {
      block: attempt.block.index,
      stream: chunk.id,
      network: iface.displayName,
      kind: attempt.kind,
      outcome: outcome.type === 'aborted' ? `aborted:${outcome.reason}` : outcome.type,
      bytes: attempt.received,
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
        return this.finishFailed(runtime, chunk, self, iface, attempt, outcome.error)
    }
  }

  private async finishCompleted(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt
  ): Promise<'continue' | 'stop'> {
    const { block } = attempt

    // Another attempt already finished this block, or is finishing it: these bytes are surplus.
    if (block.status === 'completed' || runtime.attempts.get(block.index)?.some((a) => a.won)) {
      await this.letGo(runtime, chunk, self, attempt, false)
      return 'continue'
    }
    attempt.won = true

    if (attempt.kind === 'hedge') {
      // The block's own file has to stop growing before the hedge's bytes can be joined onto it.
      const rivals = (runtime.attempts.get(block.index) ?? []).filter((a) => a !== attempt)
      for (const rival of rivals) this.abortAttempt(rival, 'lost')
      await Promise.all(rivals.map((rival) => rival.settled))

      const merged = await mergeHedge(
        partFile(runtime.tempDir, block.index),
        attempt.file,
        attempt.startOffset ?? 0,
        block.rangeEnd === null ? 0 : block.rangeEnd - block.rangeStart + 1
      ).catch(() => false)
      await rm(attempt.file, { force: true }).catch(() => {})

      if (!merged) {
        // The two didn't fit together. Whatever prefix the block's file holds is still good, so
        // the block goes back to the queue from there.
        const durable = await fileSize(partFile(runtime.tempDir, block.index))
        this.endAttempt(runtime, self, attempt)
        const removed = retractBlock(
          block,
          Math.min(block.bytesDownloaded, durable),
          attempt.networkId
        )
        chunk.bytesDownloaded = Math.max(0, chunk.bytesDownloaded - removed)
        block.status = 'pending'
        this.recomputeAggregates(runtime)
        this.goIdle(chunk)
        this.scheduleUpdate(runtime)
        return 'continue'
      }
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
        ((blockBytes - (attempt.startOffset ?? 0)) / Math.max(1, Date.now() - attempt.startedAt)) *
        1000
    }
    self.failures = 0
    // Whoever is still racing for the block has lost.
    for (const rival of runtime.attempts.get(block.index) ?? []) this.abortAttempt(rival, 'lost')
    this.recomputeAggregates(runtime)
    this.scheduleUpdate(runtime)
    return 'continue'
  }

  /** The download was paused or cancelled while the request was in flight. */
  private async finishStopped(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt
  ): Promise<'stop'> {
    const status = runtime.state.status as DownloadStatus
    let cleanup: Promise<void> = Promise.resolve()
    if (attempt.kind === 'primary') {
      this.endAttempt(runtime, self, attempt)
      if (status === 'paused') attempt.block.status = 'pending'
    } else {
      cleanup = this.letGo(runtime, chunk, self, attempt, false)
    }
    chunk.status = status === 'paused' ? 'paused' : 'cancelled'
    chunk.currentBlockIndex = undefined
    chunk.hedge = undefined
    chunk.speedBytesPerSec = 0
    await cleanup
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
    // resumes it from its part file on a new connection.
    await this.letGo(runtime, chunk, self, attempt, reason === 'refresh' && attempt.received === 0)
    if (reason === 'refresh' && attempt.kind === 'primary') {
      // A moment before this stream asks again, so that a connection already proven fast, if
      // there is one, gets to the block before this one does.
      this.scheduleUpdate(runtime)
      await delay(REFRESH_HANDOFF_MS, self.controller.signal)
      self.warmSince = Date.now()
      self.slowSince = null
    }
    return 'continue'
  }

  private async finishFailed(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    iface: NetworkInterfaceInfo,
    attempt: Attempt,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    const message = error instanceof Error ? error.message : String(error)
    chunk.error = message
    const deliveredNothing = attempt.received === 0

    if (error instanceof RemoteChangedError) {
      const verdict =
        error.check.kind === 'size'
          ? 'different'
          : await this.confirmSameBytes(runtime, iface, error.seen)
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
        chunk.error = undefined
        await this.letGo(runtime, chunk, self, attempt, false)
        return 'continue'
      }
      if (verdict === 'different') {
        // Every other worker would hit the same new version, so stop them all now rather than
        // let each burn through its retries first.
        const cleanup = this.letGo(runtime, chunk, self, attempt, false)
        chunk.status = 'error'
        runtime.state.status = 'error'
        runtime.state.error = message
        for (const other of runtime.chunkRuntimes.values()) other.controller.abort()
        await cleanup
        return 'stop'
      }
      // 'unknown' — nothing to compare yet, or the check itself failed: retry like any other
      // failed request. Nothing wrong was written either way.
    }

    // A hedge is optional work: when it fails, the block is exactly where it was.
    if (attempt.kind === 'hedge') {
      await this.letGo(runtime, chunk, self, attempt, deliveredNothing)
      return 'continue'
    }

    self.failures += 1
    chunk.retryCount += 1
    // Back to the queue, so any available worker can pick it up.
    void this.letGo(runtime, chunk, self, attempt, deliveredNothing) // nothing to clean up: a primary

    if (self.failures > MAX_CHUNK_RETRIES) {
      chunk.status = 'error'
      const allErrored = runtime.state.chunks.every((c) => c.status === 'error')
      if (allErrored && (runtime.state.status as DownloadStatus) === 'downloading') {
        runtime.state.status = 'error'
        runtime.state.error = message
        this.notify('Download Failed', `${runtime.state.fileName}: ${message}`)
        for (const other of runtime.chunkRuntimes.values()) other.controller.abort()
      }
      return 'stop'
    }

    chunk.status = 'retrying'
    this.scheduleUpdate(runtime)
    await delay(retryDelayMs(self.failures), self.controller.signal)
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
   * the block back to the queue; a hedge just drops out, taking with it any progress that only it
   * had made. When the attempt delivered nothing, its network is remembered (see scheduler.ts).
   *
   * Every change to the download's state is made before this returns, so no other stream can see
   * it half done; the promise it returns is only the removal of a hedge's file, to be awaited.
   */
  private letGo(
    runtime: DownloadRuntime,
    chunk: ChunkState,
    self: ChunkRuntime,
    attempt: Attempt,
    deliveredNothing: boolean
  ): Promise<void> {
    this.endAttempt(runtime, self, attempt)
    const { block } = attempt
    if (attempt.kind === 'primary') {
      // Not if another attempt has decided the block already: it is that one's to finish.
      const decided = runtime.attempts.get(block.index)?.some((other) => other.won)
      if (block.status === 'downloading' && !decided) block.status = 'pending'
    } else {
      this.retractHedge(runtime, chunk, attempt)
    }
    if (deliveredNothing) runtime.avoidNetworkByBlock.set(block.index, attempt.networkId)
    this.goIdle(chunk)
    return attempt.kind === 'hedge'
      ? rm(attempt.file, { force: true }).catch(() => {})
      : Promise.resolve()
  }

  /** Takes back the progress a hedge alone had made, now that it is not going to finish. */
  private retractHedge(runtime: DownloadRuntime, chunk: ChunkState, hedge: Attempt): void {
    // A finished block is finished: whoever lost the race for it has nothing to take back.
    if (hedge.block.status === 'completed') return
    const keep = Math.max(hedge.startOffset ?? 0, this.otherAttemptsPosition(runtime, hedge))
    const removed = retractBlock(hedge.block, keep, hedge.networkId)
    if (removed > 0) {
      chunk.bytesDownloaded = Math.max(0, chunk.bytesDownloaded - removed)
      this.recomputeAggregates(runtime)
    }
  }

  private async runWorker(runtime: DownloadRuntime, chunk: ChunkState): Promise<void> {
    const iface =
      runtime.activeInterfaces.find((i) => i.id === chunk.interfaceId) ??
      runtime.activeInterfaces[chunk.id % runtime.activeInterfaces.length] ??
      runtime.activeInterfaces[0]

    if (!iface) {
      chunk.status = 'error'
      chunk.error = 'No active network interface available'
      this.scheduleUpdate(runtime)
      return
    }

    const controller = new AbortController()
    const self: ChunkRuntime = {
      controller,
      attempt: null,
      warmSince: Date.now(),
      slowSince: null,
      lastBlockSpeed: 0,
      receivedBytes: 0,
      failures: 0
    }
    runtime.chunkRuntimes.set(chunk.id, self)

    while (runtime.state.status === 'downloading') {
      if (controller.signal.aborted) break

      // Taken atomically: nothing between choosing the work and registering it can yield.
      const work = pickWork(
        {
          blocks: runtime.blocks,
          streams: runtime.state.chunks,
          attempts: runtime.attempts,
          avoid: runtime.avoidNetworkByBlock,
          hedgesUsed: runtime.hedgesByBlock
        },
        { id: chunk.id, networkId: iface.id },
        Date.now(),
        SCHEDULER_POLICY
      )
      if (!work) {
        this.goIdle(chunk)
        // While blocks are still in flight, stay available in case one fails and is handed back,
        // or turns out to be slow enough to be worth racing.
        if (runtime.blocks.some((b) => b.status === 'pending' || b.status === 'downloading')) {
          this.scheduleUpdate(runtime)
          await delay(250, controller.signal)
          continue
        }
        chunk.status = 'completed'
        this.scheduleUpdate(runtime)
        break
      }

      const attempt = this.beginAttempt(runtime, chunk, self, iface, work)
      this.scheduleUpdate(runtime)
      const outcome = await this.executeAttempt(runtime, chunk, self, iface, attempt)
      let next: 'continue' | 'stop'
      try {
        next = await this.finishAttempt(runtime, chunk, self, iface, attempt, outcome)
      } finally {
        this.endAttempt(runtime, self, attempt)
      }
      if (next === 'stop') break
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
    iface: NetworkInterfaceInfo,
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
      const partPath = partFile(runtime.tempDir, block.index)
      let local: Buffer
      try {
        local = (await readFile(partPath)).subarray(0, SAMPLE_BYTES)
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
            iface.address
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

  private recomputeAggregates(runtime: DownloadRuntime): void {
    runtime.state.bytesDownloaded = runtime.blocks.reduce(
      (sum, entry) => sum + entry.bytesDownloaded,
      0
    )
    runtime.state.speedBytesPerSec = sumChunkSpeeds(runtime)
  }

  private scheduleUpdate(runtime: DownloadRuntime): void {
    if (runtime.pushScheduled) return
    runtime.pushScheduled = true
    setTimeout(() => {
      runtime.pushScheduled = false
      this.pushUpdate(runtime)
    }, PROGRESS_THROTTLE_MS)
  }

  private pushUpdate(runtime: DownloadRuntime, persist = true): void {
    // A removed download can still be winding down (workers finishing, cleanup). Its updates
    // would put it back on screen after the renderer has already moved on.
    if (this.runtimes.get(runtime.state.id) !== runtime) return
    if (persist) this.schedulePersistence(runtime)
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    if (runtime.state.status === 'paused' || runtime.state.status === 'cancelled') {
      runtime.state.speedBytesPerSec = 0
    }
    window.webContents.send(IpcChannels.downloadUpdated, structuredClone(runtime.state))
  }

  /**
   * Concatenates the part files into the destination, refusing to write a file
   * that isn't demonstrably the whole download. Every check here is a backstop
   * for a bug elsewhere rather than an expected condition — but the failure
   * mode it guards against is the worst one this app has: handing the user a
   * truncated file, calling it completed, and deleting the parts that would
   * have let them resume it.
   */
  private async reassemble(runtime: DownloadRuntime): Promise<void> {
    const missing = runtime.blocks.filter((block) => block.status !== 'completed')
    if (missing.length > 0) {
      throw new Error(
        `Download is incomplete: ${missing.length} of ${runtime.totalBlocks} parts never finished`
      )
    }

    const ASSEMBLE_STREAM_BUFFER_BYTES = 1024 * 1024 // 1 MB buffer for fast sequential disk assembly
    const output = createWriteStream(runtime.state.destinationPath, {
      highWaterMark: ASSEMBLE_STREAM_BUFFER_BYTES
    })
    // pipeline reports a failure by rejecting, but only listens while it runs: destroying the
    // output afterwards can still surface an in-flight write as an 'error' event, and an
    // unhandled 'error' on a stream takes down the main process rather than failing this one
    // download. So one listener stays for the stream's whole life.
    output.on('error', () => {})

    let bytesWritten = 0
    // A single pipeline for the whole file, not one per part: pipeline leaves its listeners on
    // a destination it doesn't end, so one per part would pile up on the output — five per part.
    const source = Readable.from(
      this.readParts(runtime, ASSEMBLE_STREAM_BUFFER_BYTES, (partBytes) => {
        bytesWritten += partBytes
        // Reported per part rather than per underlying write so the assembling visualization
        // advances in the same units the block grid already shows — one step per chunk, not a
        // byte stream.
        runtime.state.assembledBytes = bytesWritten
        this.scheduleUpdate(runtime)
      }),
      { objectMode: false, highWaterMark: ASSEMBLE_STREAM_BUFFER_BYTES }
    )

    try {
      // Rejects on an error from either side, and destroys both.
      await pipeline(source, output)

      if (runtime.state.totalBytes > 0 && bytesWritten !== runtime.state.totalBytes) {
        throw new Error(
          `Assembled file is ${bytesWritten} bytes but should be ${runtime.state.totalBytes} — refusing to keep a corrupt file`
        )
      }
    } catch (error) {
      output.destroy()
      await finished(output).catch(() => {})
      // Leaving a half-written file where the user expects their download is
      // worse than leaving nothing: it looks like the download they asked for.
      await rm(runtime.state.destinationPath, { force: true })
      throw error
    }
  }

  /** The download's bytes in file order: each part checked against the size its range says, then
   * read through. `onPartRead` is told how many bytes each part held, once it has been read. */
  private async *readParts(
    runtime: DownloadRuntime,
    bufferBytes: number,
    onPartRead: (partBytes: number) => void
  ): AsyncGenerator<Buffer> {
    // Set only for a dev-tool simulated download that asked for a slowed-down assemble — real
    // downloads always reassemble at full disk speed. Throttling here (rather than faking it in
    // the renderer) exercises the exact same assembledBytes/IPC path a real assemble uses.
    const assembleSpeedBytesPerSec = getSimAssembleSpeed(runtime.requestPayload.url)

    for (let i = 0; i < runtime.totalBlocks; i++) {
      const partPath = partFile(runtime.tempDir, i)
      const block = runtime.blocks[i]
      const expectedBytes = block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1
      const actualBytes = (await stat(partPath)).size

      if (expectedBytes !== null && actualBytes !== expectedBytes) {
        throw new Error(
          `Part ${i} is ${actualBytes} bytes but should be ${expectedBytes} — refusing to write a corrupt file`
        )
      }

      let read = 0
      for await (const chunk of createReadStream(partPath, { highWaterMark: bufferBytes })) {
        read += (chunk as Buffer).length
        yield chunk as Buffer
      }
      if (read !== actualBytes) {
        throw new Error(
          `Part ${i} changed while it was being assembled — refusing to write a corrupt file`
        )
      }

      if (assembleSpeedBytesPerSec) {
        await sleep(Math.max(1, (read / assembleSpeedBytesPerSec) * 1000))
      }
      onPartRead(read)
    }
  }

  /**
   * Releases the placeholder file reserved at start when the download won't be
   * filling it in, so its name is free for the next attempt. Only ever removes
   * a path this download created and never finished writing — a completed
   * download keeps its file.
   */
  private async discardUnfinishedDestination(runtime: DownloadRuntime): Promise<void> {
    if (runtime.state.status === 'completed') return
    try {
      await rm(runtime.state.destinationPath, { force: true })
    } catch {
      // Best-effort — a stray empty file isn't worth failing the download over.
    }
  }

  private async cleanupTempDir(runtime: DownloadRuntime): Promise<void> {
    unregisterSimSession(runtime.requestPayload.url)
    try {
      await rm(runtime.tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup — a leftover temp dir isn't worth surfacing an error for.
    }
  }

  private schedulePersistence(runtime: DownloadRuntime): void {
    if (this.suspending || runtime.removed || runtime.persistenceTimer) return
    runtime.persistenceTimer = setTimeout(() => {
      runtime.persistenceTimer = undefined
      void this.persistNow(runtime)
    }, PROGRESS_THROTTLE_MS)
  }

  private persistNow(runtime: DownloadRuntime): Promise<void> {
    if (runtime.removed) return runtime.persistenceChain
    if (runtime.persistenceTimer) {
      clearTimeout(runtime.persistenceTimer)
      runtime.persistenceTimer = undefined
    }

    runtime.persistenceChain = runtime.persistenceChain
      .catch(() => {})
      .then(async () => {
        if (runtime.removed) return
        const dir = this.downloadDir(runtime.state.id)
        const path = this.manifestPath(runtime.state.id)
        const temporaryPath = `${path}.tmp`
        const persisted: PersistedDownload = {
          version: 1,
          savedAt: Date.now(),
          state: structuredClone(runtime.state),
          requestPayload: runtime.requestPayload,
          activeInterfaces: runtime.activeInterfaces
        }
        await mkdir(dir, { recursive: true })
        await writeFile(temporaryPath, JSON.stringify(persisted), 'utf-8')
        await rename(temporaryPath, path)
      })
      .catch(() => {
        // Progress persistence is best-effort; transfer errors are surfaced separately.
      })
    return runtime.persistenceChain
  }

  private async removePersistedDownload(runtime: DownloadRuntime): Promise<void> {
    runtime.removed = true
    if (runtime.persistenceTimer) clearTimeout(runtime.persistenceTimer)
    await runtime.persistenceChain.catch(() => {})
    try {
      await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  }
}
