import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  truncate,
  writeFile
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  BlockState,
  ChunkState,
  DownloadState,
  DownloadStatus,
  NetworkInterfaceInfo,
  StartDownloadRequest
} from '../../shared/types'
import { assembleTorrentFiles } from '../torrent/assemble'
import { parseMagnetUri } from '../torrent/magnet'
import { resolveTorrentMetadata } from '../torrent/metadata'
import { recallMetadata, toTorrentMetadata } from '../torrent/metadataStore'
import { parseInfoDict, pieceLengthAt, type TorrentInfo } from '../torrent/torrentInfo'
import { TorrentSession, type TorrentSlot, type TorrentSlotState } from '../torrent/torrentSession'
import { downloadChunk } from './chunkDownloader'
import { reserveDestinationDirectory, reserveDestinationPath } from './paths'
import { isResourceUnchanged } from './probe'

interface ChunkRuntime {
  controller: AbortController
  partPath: string
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
  /** Torrent downloads only: the parsed metadata every piece offset derives from, loaded
   * from the swarm at start and from disk on a resume. */
  torrentInfo?: TorrentInfo
  /** Torrent downloads only: aborts the swarm session on pause or cancel, the way the
   * per-chunk controllers do for HTTP. */
  torrentController?: AbortController
}

interface PersistedDownload {
  version: 1
  savedAt: number
  state: DownloadState
  requestPayload: StartDownloadRequest
  activeInterfaces: NetworkInterfaceInfo[]
}

const PROGRESS_THROTTLE_MS = 200

// Raw per-event deltas are too noisy to display (socket buffers flush in
// irregular bursts a few ms apart). Averaging over a few seconds instead
// gives a speed/ETA reading that tracks reality without jumping around.
const SPEED_WINDOW_MS = 3000

// Appends a sample and returns the average byte rate over SPEED_WINDOW_MS.
function pushSpeedSample(samples: SpeedSample[], bytes: number, time: number): number {
  samples.push({ bytes, time })

  const cutoff = time - SPEED_WINDOW_MS
  while (samples.length > 2 && samples[1].time <= cutoff) {
    samples.shift()
  }

  const oldest = samples[0]
  const deltaSeconds = (time - oldest.time) / 1000
  return deltaSeconds > 0 ? (bytes - oldest.bytes) / deltaSeconds : 0
}

// Defensive cap independent of whatever the renderer sends — chunks are
// distributed round-robin across interfaces, not tied 1:1 to them anymore.
const MAX_CHUNKS = 32

/**
 * Peer-slot ceiling for a torrent, far above MAX_CHUNKS because the two are not the same
 * quantity.
 *
 * An HTTP connection gets the server's full attention, so a handful saturates a link and more
 * would just be rude. A BitTorrent peer is the opposite: it serves only while it has chosen to
 * unchoke you, most of a tracker's list is stale or unreachable, and any one peer is a trickle.
 * Throughput comes from holding many connections at once — real clients sit in the tens to low
 * hundreds. Capping a torrent at 32 was leaving the download running on one or two peers.
 */
const MAX_TORRENT_PEERS = 100

/** Peer slots per network when the request doesn't say. Chosen to be useful rather than
 * timid: at the HTTP default of 2, a 6 GB torrent ran at 16 KB/s. */
const DEFAULT_TORRENT_PEERS_PER_NETWORK = 50

const MAX_CHUNK_RETRIES = 5
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 15_000

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
}

/** Records that `interfaceId` delivered `deltaBytes` of this block. Attribution is per-network
 * rather than a single winner because one block can be started on one network and finished on
 * another (a retry after a dropped connection, or a pause/resume), and the grid colors blocks
 * by who actually moved the bytes. */
function creditBlockBytes(block: BlockState, interfaceId: string, deltaBytes: number): void {
  if (deltaBytes <= 0) return
  block.bytesByInterface[interfaceId] = (block.bytesByInterface[interfaceId] ?? 0) + deltaBytes
}

/** Drops attribution for bytes that turned out not to be on disk, so the per-network tallies
 * keep summing to the block's real byte count. The lost bytes are always at the tail of the
 * part file, so they come off the network that wrote last before spilling over to the rest. */
function trimBlockAttribution(block: BlockState, keepBytes: number, lastWriter?: string): void {
  let attributed = 0
  for (const bytes of Object.values(block.bytesByInterface)) attributed += bytes

  let excess = attributed - keepBytes
  if (excess <= 0) return

  const order = Object.keys(block.bytesByInterface).sort((a, b) =>
    a === lastWriter ? -1 : b === lastWriter ? 1 : 0
  )

  for (const interfaceId of order) {
    if (excess <= 0) break
    const taken = Math.min(block.bytesByInterface[interfaceId], excess)
    const remaining = block.bytesByInterface[interfaceId] - taken
    excess -= taken
    if (remaining > 0) block.bytesByInterface[interfaceId] = remaining
    else delete block.bytesByInterface[interfaceId]
  }
}

/** Total live speed across a download's worker connections (bounded by MAX_CHUNKS, unlike blocks). */
function sumChunkSpeeds(runtime: DownloadRuntime): number {
  let total = 0
  for (const chunk of runtime.state.chunks) {
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

// A part file's on-disk size is the only thing we can actually trust across
// a retry or resume — appending opens the file with flag 'a', which always
// writes at the real end-of-file regardless of what byte count we think
// we're at, so any mismatch (a crash, a write that hadn't flushed yet)
// would otherwise silently shift every byte after it. Truncating to the
// smaller of the two counts keeps the part file's length and our own
// bookkeeping in agreement before we append another byte to it.
async function reconcilePartFileSize(partPath: string, expectedBytes: number): Promise<number> {
  let actualBytes = 0
  try {
    actualBytes = (await stat(partPath)).size
  } catch {
    actualBytes = 0
  }

  const safeBytes = Math.min(expectedBytes, actualBytes)
  if (actualBytes !== safeBytes) {
    await truncate(partPath, safeBytes)
  }
  return safeBytes
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** Throws if the destination volume doesn't have room for the download — a full disk should
 * fail upfront with a clear reason, not partway through as a confusing ENOSPC write error. */
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

/** Appends one file's bytes onto an already-open writable, without ending it. */
function appendFileToStream(sourcePath: string, output: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const input = createReadStream(sourcePath)
    input.on('error', reject)
    input.on('data', (chunk) => {
      const canContinue = output.write(chunk)
      if (!canContinue) {
        input.pause()
        output.once('drain', () => input.resume())
      }
    })
    input.on('close', resolve)
  })
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
          // Manifests written before torrent support carry no `kind`.
          state.kind = state.kind ?? 'http'
          if (state.status === 'downloading') {
            state.status = 'paused'
            state.pausedAt = persisted.savedAt || Date.now()
          }
          state.speedBytesPerSec = 0
          for (const chunk of state.chunks) {
            chunk.speedBytesPerSec = 0
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

          if (state.kind === 'torrent') {
            // A torrent piece stays buffered in memory until it passes its hash, so an
            // unfinished one left nothing on disk to resume from. Its progress has to go
            // back to zero rather than be shown as recoverable.
            for (const block of blocks) {
              if (block.status === 'completed') continue
              block.bytesDownloaded = 0
              block.bytesByInterface = {}
            }
            state.bytesDownloaded = blocks.reduce((sum, block) => sum + block.bytesDownloaded, 0)
          }

          const runtime: DownloadRuntime = {
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
            removed: false
          }
          this.runtimes.set(id, runtime)
          await this.persistNow(runtime)
        } catch {
          // Ignore incomplete or corrupt manifests; other downloads can still be restored.
        }
      })
    )
  }

  async getCurrentDownload(): Promise<DownloadState | null> {
    await this.initialization
    const latest = [...this.runtimes.values()].sort(
      (a, b) => b.state.startedAt - a.state.startedAt
    )[0]
    return latest ? structuredClone(latest.state) : null
  }

  async start(requestPayload: StartDownloadRequest): Promise<string> {
    await this.initialization
    const interfaces = requestPayload.interfaceIds
      .map((interfaceId) => this.getInterfaceById(interfaceId))
      .filter((iface): iface is NetworkInterfaceInfo => Boolean(iface))

    if (interfaces.length === 0) {
      throw new Error('Select at least one network interface')
    }

    if (requestPayload.kind === 'torrent') {
      return this.startTorrent(requestPayload, interfaces)
    }

    await ensureDiskSpace(requestPayload.destinationDir, requestPayload.totalBytes)

    const id = randomUUID()
    const tempDir = join(this.downloadDir(id), 'parts')
    await mkdir(tempDir, { recursive: true })

    // Claimed on disk, not just picked, so a second download of the same file
    // name can't pick it too and overwrite this one at reassembly time.
    const destinationPath = await reserveDestinationPath(
      requestPayload.destinationDir,
      requestPayload.suggestedFileName
    )

    const connectionsPerNetwork = Math.max(
      1,
      Math.min(
        8,
        requestPayload.connectionsPerNetwork ??
          Math.max(1, Math.round(requestPayload.chunkCount / interfaces.length))
      )
    )
    const canSplit = requestPayload.supportsRanges && requestPayload.totalBytes > 0

    // Block size stays fixed regardless of file size, so work granularity — and
    // therefore resumability and load-balancing across workers — doesn't degrade
    // on huge files. MAX_REAL_BLOCKS is only a safety valve for pathologically
    // large files (multi-TB) so the block array doesn't blow up; it grows the
    // block size instead of the count once a file is big enough to hit it.
    // The UI caps how many cells it renders separately (see BlockGrid), by
    // bucketing these blocks rather than by shrinking their count here.
    const BASE_BLOCK_BYTES = 8 * 1024 * 1024 // 8 MB
    const MAX_REAL_BLOCKS = 4096

    let blockSizeBytes = 0
    const blocks: BlockState[] = []

    if (canSplit) {
      blockSizeBytes = Math.max(
        BASE_BLOCK_BYTES,
        Math.ceil(requestPayload.totalBytes / MAX_REAL_BLOCKS)
      )
      let offset = 0
      let bIdx = 0
      while (offset < requestPayload.totalBytes) {
        const bEnd = Math.min(offset + blockSizeBytes - 1, requestPayload.totalBytes - 1)
        blocks.push({
          index: bIdx++,
          rangeStart: offset,
          rangeEnd: bEnd,
          status: 'pending',
          bytesDownloaded: 0,
          bytesByInterface: {}
        })
        offset = bEnd + 1
      }
    } else {
      blockSizeBytes = requestPayload.totalBytes > 0 ? requestPayload.totalBytes : 0
      blocks.push({
        index: 0,
        rangeStart: 0,
        rangeEnd: requestPayload.totalBytes > 0 ? requestPayload.totalBytes - 1 : null,
        status: 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {}
      })
    }

    const chunks: ChunkState[] = []
    const activeInterfaces: NetworkInterfaceInfo[] = []
    let workerIdCounter = 0

    if (canSplit) {
      for (const iface of interfaces) {
        for (let connIdx = 0; connIdx < connectionsPerNetwork; connIdx++) {
          if (chunks.length >= MAX_CHUNKS) break
          activeInterfaces.push(iface)
          chunks.push({
            id: workerIdCounter++,
            interfaceId: iface.id,
            interfaceLabel: iface.displayName,
            interfaceKind: iface.kind,
            rangeStart: 0,
            rangeEnd: null,
            bytesDownloaded: 0,
            speedBytesPerSec: 0,
            status: 'pending',
            retryCount: 0
          })
        }
      }
    } else {
      activeInterfaces.push(interfaces[0])
      chunks.push({
        id: 0,
        interfaceId: interfaces[0].id,
        interfaceLabel: interfaces[0].displayName,
        interfaceKind: interfaces[0].kind,
        rangeStart: 0,
        rangeEnd: requestPayload.totalBytes > 0 ? requestPayload.totalBytes - 1 : null,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'pending',
        retryCount: 0
      })
    }

    const state: DownloadState = {
      id,
      kind: 'http',
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
      blockSizeBytes,
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
      removed: false
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

    runtime.state.status = 'paused'
    runtime.state.speedBytesPerSec = 0
    runtime.state.pausedAt = Date.now()
    for (const chunk of runtime.state.chunks) {
      if (chunk.status !== 'completed') {
        chunk.status = 'paused'
      }
      chunk.speedBytesPerSec = 0
    }
    for (const block of runtime.blocks) {
      if (block.status === 'downloading') {
        block.status = 'pending'
      }
    }
    for (const chunkRuntime of runtime.chunkRuntimes.values()) {
      chunkRuntime.controller.abort()
    }
    runtime.torrentController?.abort()
    this.pushUpdate(runtime)
    await this.persistNow(runtime)
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.state.status !== 'paused') return

    void this.resumeAfterVerifying(runtime)
  }

  // Appending onto part files assumes the remote file hasn't changed since
  // it was probed — if the server's ETag/Last-Modified moved on while this
  // download sat paused, resuming would silently stitch old and new bytes
  // together. Check first, and refuse to resume rather than corrupt the
  // output (the user can always start the download over from scratch).
  private async resumeAfterVerifying(runtime: DownloadRuntime): Promise<void> {
    // A torrent has nothing to check here. Every piece is verified against a SHA-1 published
    // in metadata whose own hash is the magnet link, so content that moved on underneath us
    // fails its piece hash and is discarded — it can never be stitched into the output the
    // way changed HTTP bytes could.
    if (runtime.state.kind === 'http') {
      const { url, etag, lastModified } = runtime.requestPayload
      const unchanged = await isResourceUnchanged(url, etag, lastModified)

      if (runtime.state.status !== 'paused') return // cancelled while we were checking

      if (!unchanged) {
        runtime.state.status = 'error'
        runtime.state.error =
          'The remote file changed while this download was paused, so resuming would corrupt it. Start the download over instead.'
        this.pushUpdate(runtime)
        await this.cleanupTempDir(runtime)
        await this.discardUnfinishedDestination(runtime)
        return
      }
    }

    let availableInterfaces: NetworkInterfaceInfo[]
    try {
      availableInterfaces = await this.refreshInterfaces()
    } catch {
      runtime.state.error = 'Could not refresh network interfaces. Try resuming again.'
      this.pushUpdate(runtime)
      return
    }
    if (runtime.state.status !== 'paused') return

    const selectedIds = new Set(runtime.requestPayload.interfaceIds)
    runtime.activeInterfaces = availableInterfaces.filter((iface) => selectedIds.has(iface.id))
    if (runtime.activeInterfaces.length === 0) {
      runtime.state.error =
        'None of the networks selected for this download are currently available. Reconnect one and try again.'
      this.pushUpdate(runtime)
      return
    }

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
      // An unfinished torrent piece was only ever buffered in memory — nothing of it
      // survived the pause, so its progress starts over rather than resuming.
      if (runtime.state.kind === 'torrent' && block.status !== 'completed') {
        block.bytesDownloaded = 0
        block.bytesByInterface = {}
      }
    }
    for (const chunk of runtime.state.chunks) {
      if (chunk.status !== 'completed') {
        chunk.status = 'pending'
      }
      runtime.speedSamplesByChunk.delete(chunk.id)
      chunk.speedBytesPerSec = 0
    }
    this.recomputeAggregates(runtime)
    this.pushUpdate(runtime)

    if (runtime.state.kind === 'torrent') {
      void this.runTorrentToCompletion(runtime)
      return
    }

    const pending = runtime.state.chunks.filter((chunk) => chunk.status !== 'completed')
    void this.runChunksToCompletion(runtime, pending.length > 0 ? pending : runtime.state.chunks)
  }

  cancel(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || (runtime.state.status !== 'downloading' && runtime.state.status !== 'paused'))
      return

    runtime.state.status = 'cancelled'
    runtime.state.speedBytesPerSec = 0
    for (const chunk of runtime.state.chunks) {
      chunk.speedBytesPerSec = 0
      chunk.status = 'cancelled'
    }
    for (const chunkRuntime of runtime.chunkRuntimes.values()) {
      chunkRuntime.controller.abort()
    }
    runtime.torrentController?.abort()
    this.pushUpdate(runtime, false)
    void this.cleanupTempDir(runtime)
    void this.discardUnfinishedDestination(runtime)
    void this.removePersistedDownload(runtime)
  }

  remove(id: string): void {
    const runtime = this.runtimes.get(id)
    if (runtime && (runtime.state.status === 'downloading' || runtime.state.status === 'paused')) {
      this.cancel(id)
    }
    this.runtimes.delete(id)
    if (runtime) void this.removePersistedDownload(runtime)
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

  private metadataPath(id: string): string {
    return join(this.downloadDir(id), 'metadata.bin')
  }

  /**
   * Starts a magnet-link download.
   *
   * Deliberately the same shape as `start`: a torrent piece becomes a block and a peer slot
   * becomes a chunk, so persistence, the progress grid, per-network byte attribution and
   * pause/resume all keep working without knowing a torrent is involved.
   */
  private async startTorrent(
    requestPayload: StartDownloadRequest,
    interfaces: NetworkInterfaceInfo[]
  ): Promise<string> {
    const magnet = parseMagnetUri(requestPayload.url)

    // The probe behind this request already resolved the metadata; going back to the swarm
    // is only the fallback for a request that outlived that cache.
    const cached = recallMetadata(magnet.infoHashHex)
    const resolved =
      cached ??
      (await resolveTorrentMetadata({
        magnet,
        interfaces,
        signal: new AbortController().signal
      }))
    const info = resolved.info

    await ensureDiskSpace(requestPayload.destinationDir, info.totalLength)

    const id = randomUUID()
    const tempDir = join(this.downloadDir(id), 'parts')
    await mkdir(tempDir, { recursive: true })

    // Stored next to the parts so a resume can rebuild the piece map without having to find
    // a peer willing to serve metadata again. It is re-verified against the infohash when
    // read back, so an edited file is rejected rather than trusted.
    await writeFile(this.metadataPath(id), resolved.raw)

    const destinationPath = info.isSingleFile
      ? await reserveDestinationPath(requestPayload.destinationDir, info.name)
      : await reserveDestinationDirectory(requestPayload.destinationDir, info.name)

    const peersPerNetwork = Math.max(
      1,
      Math.min(
        MAX_TORRENT_PEERS,
        requestPayload.connectionsPerNetwork ?? DEFAULT_TORRENT_PEERS_PER_NETWORK
      )
    )

    // One block per piece, on the torrent's own boundaries. Unlike the HTTP engine's block
    // size this isn't ours to pick: pieces are the unit the swarm serves and verifies.
    const blocks: BlockState[] = info.pieceHashes.map((_hash, index) => {
      const rangeStart = index * info.pieceLength
      return {
        index,
        rangeStart,
        rangeEnd: rangeStart + pieceLengthAt(info, index) - 1,
        status: 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {}
      }
    })

    // The shared ceiling is divided between the networks up front rather than handed out
    // first-come. Filling network by network would give the whole budget to whichever
    // networks came first — with three networks at 50 each against a cap of 100, the third
    // would get no slots at all and could never contribute a byte.
    const slotsPerNetwork = Math.max(
      1,
      Math.min(peersPerNetwork, Math.floor(MAX_TORRENT_PEERS / interfaces.length))
    )

    const chunks: ChunkState[] = []
    const activeInterfaces: NetworkInterfaceInfo[] = []
    // Interleaved — one slot per network per pass, not all of one network then all of the
    // next. `fillSlots` hands peers out in slot order, so this ordering is what makes the
    // peer queue rotate between networks instead of being drained by the first one.
    for (let connection = 0; connection < slotsPerNetwork; connection += 1) {
      for (const iface of interfaces) {
        if (chunks.length >= MAX_TORRENT_PEERS) break
        activeInterfaces.push(iface)
        chunks.push({
          id: chunks.length,
          interfaceId: iface.id,
          interfaceLabel: iface.displayName,
          interfaceKind: iface.kind,
          rangeStart: 0,
          rangeEnd: null,
          bytesDownloaded: 0,
          speedBytesPerSec: 0,
          status: 'pending',
          retryCount: 0
        })
      }
    }

    const state: DownloadState = {
      id,
      kind: 'torrent',
      url: magnet.uri,
      fileName: basename(destinationPath),
      destinationPath,
      totalBytes: info.totalLength,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'downloading',
      chunks,
      blocks,
      totalBlocks: blocks.length,
      blockSizeBytes: info.pieceLength,
      torrent: toTorrentMetadata(info, magnet.infoHashHex),
      connectedPeers: 0,
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
      torrentInfo: info
    }
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)

    void this.runTorrentToCompletion(runtime)

    return id
  }

  /** The piece map for a torrent runtime, read back from disk after an app restart. */
  private async ensureTorrentInfo(runtime: DownloadRuntime): Promise<TorrentInfo> {
    if (runtime.torrentInfo) return runtime.torrentInfo

    const magnet = parseMagnetUri(runtime.state.url)
    const raw = await readFile(this.metadataPath(runtime.state.id))
    // Re-derives the infohash from the file, so metadata changed between runs is rejected
    // rather than quietly pointing the download at different content.
    const info = parseInfoDict(raw, magnet.infoHash)
    runtime.torrentInfo = info
    return info
  }

  /** Runs a torrent's peer slots until every piece is verified, then writes out its files. */
  private async runTorrentToCompletion(runtime: DownloadRuntime): Promise<void> {
    let info: TorrentInfo
    try {
      info = await this.ensureTorrentInfo(runtime)
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = `Could not read this torrent's metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
      this.pushUpdate(runtime)
      await this.cleanupTempDir(runtime)
      await this.discardUnfinishedDestination(runtime)
      return
    }

    const controller = new AbortController()
    runtime.torrentController = controller

    try {
      const slots: TorrentSlot[] = runtime.state.chunks.map((chunk, index) => {
        const iface =
          runtime.activeInterfaces.find((entry) => entry.id === chunk.interfaceId) ??
          runtime.activeInterfaces[index % runtime.activeInterfaces.length]
        return { id: chunk.id, interfaceId: iface.id, localAddress: iface.address }
      })

      const session = new TorrentSession({
        magnet: parseMagnetUri(runtime.state.url),
        info,
        partsDir: runtime.tempDir,
        slots,
        completedPieces: runtime.blocks
          .filter((block) => block.status === 'completed')
          .map((block) => block.index),
        signal: controller.signal,
        onProgress: (slotId, pieceIndex, deltaBytes) => {
          const chunk = runtime.state.chunks.find((entry) => entry.id === slotId)
          if (!chunk) return
          this.onWorkerProgress(runtime, slotId, pieceIndex, chunk.interfaceId, deltaBytes)
        },
        onPieceReset: (pieceIndex) => this.onTorrentPieceReset(runtime, pieceIndex),
        onPieceComplete: (pieceIndex) => this.onTorrentPieceComplete(runtime, pieceIndex),
        onSlotChanged: (slotId, slotState) => this.onTorrentSlotChanged(runtime, slotId, slotState)
      })

      await session.run()
    } catch (error) {
      const status = runtime.state.status as DownloadStatus

      // Pause and cancel abort the session deliberately, so that rejection is the expected
      // outcome rather than a failure worth reporting.
      if (status !== 'downloading') {
        for (const chunk of runtime.state.chunks) {
          chunk.speedBytesPerSec = 0
          chunk.peerAddress = undefined
          if (chunk.status !== 'completed') {
            chunk.status = status === 'paused' ? 'paused' : 'cancelled'
          }
        }
        runtime.state.connectedPeers = 0
        this.pushUpdate(runtime)
        return
      }

      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      runtime.state.speedBytesPerSec = 0
      runtime.state.connectedPeers = 0
      for (const chunk of runtime.state.chunks) {
        chunk.speedBytesPerSec = 0
        chunk.peerAddress = undefined
        chunk.status = 'error'
      }
      this.pushUpdate(runtime)
      await this.cleanupTempDir(runtime)
      await this.discardUnfinishedDestination(runtime)
      return
    } finally {
      runtime.torrentController = undefined
    }

    if (runtime.state.status !== 'downloading') return

    try {
      await assembleTorrentFiles({
        info,
        partsDir: runtime.tempDir,
        destinationPath: runtime.state.destinationPath
      })
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      runtime.state.bytesDownloaded = runtime.state.totalBytes || runtime.state.bytesDownloaded
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
    }

    const completed = runtime.state.status === 'completed'
    runtime.state.speedBytesPerSec = 0
    runtime.state.connectedPeers = 0
    for (const chunk of runtime.state.chunks) {
      chunk.speedBytesPerSec = 0
      chunk.peerAddress = undefined
      chunk.status = completed ? 'completed' : 'error'
    }

    this.pushUpdate(runtime)
    await this.cleanupTempDir(runtime)
    await this.discardUnfinishedDestination(runtime)
  }

  /** Gives back a piece's progress after its buffered bytes were discarded — a failed hash,
   * or a part file that turned out not to be on disk. */
  private onTorrentPieceReset(runtime: DownloadRuntime, pieceIndex: number): void {
    const block = runtime.blocks[pieceIndex]
    if (!block) return

    block.status = 'pending'
    block.bytesDownloaded = 0
    block.bytesByInterface = {}
    this.recomputeAggregates(runtime)
    this.scheduleUpdate(runtime)
  }

  private onTorrentPieceComplete(runtime: DownloadRuntime, pieceIndex: number): void {
    const block = runtime.blocks[pieceIndex]
    if (!block) return

    block.status = 'completed'
    // Unlike an HTTP block there is no shortfall to square up: a piece is only complete once
    // every one of its 16 KiB blocks has been counted exactly once.
    this.recomputeAggregates(runtime)
    this.scheduleUpdate(runtime)
  }

  private onTorrentSlotChanged(
    runtime: DownloadRuntime,
    slotId: number,
    slotState: TorrentSlotState
  ): void {
    const chunk = runtime.state.chunks.find((entry) => entry.id === slotId)
    if (!chunk) return

    chunk.peerAddress = slotState.peer ?? undefined
    chunk.currentBlockIndex = slotState.pieceIndex ?? undefined
    if (!slotState.connected) chunk.speedBytesPerSec = 0
    if (runtime.state.status === 'downloading') {
      chunk.status = slotState.connected ? 'downloading' : 'pending'
    }

    // Same split as the HTTP engine: the block records who is working it now, while
    // bytesByInterface records who actually delivered the bytes.
    if (slotState.pieceIndex !== null) {
      const block = runtime.blocks[slotState.pieceIndex]
      if (block && block.status !== 'completed') {
        block.status = 'downloading'
        block.interfaceId = chunk.interfaceId
      }
    }

    runtime.state.connectedPeers = runtime.state.chunks.filter(
      (entry) => entry.peerAddress !== undefined
    ).length
    this.scheduleUpdate(runtime)
  }

  /** Runs (or resumes) fixed worker streams in parallel, leasing blocks until all are completed. */
  private async runChunksToCompletion(
    runtime: DownloadRuntime,
    chunks: ChunkState[]
  ): Promise<void> {
    const active = new Map<number, Promise<number>>()
    for (const chunk of chunks) {
      active.set(
        chunk.id,
        this.runWorker(runtime, chunk).then(() => chunk.id)
      )
    }

    while (active.size > 0) {
      const finishedId = await Promise.race(active.values())
      active.delete(finishedId)
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

    try {
      await this.reassemble(runtime)
      runtime.state.status = 'completed'
      runtime.state.completedAt = Date.now()
      runtime.state.bytesDownloaded = runtime.state.totalBytes || runtime.state.bytesDownloaded
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
    }

    this.pushUpdate(runtime)
    await this.cleanupTempDir(runtime)
    await this.discardUnfinishedDestination(runtime)
  }

  private async runWorker(runtime: DownloadRuntime, chunk: ChunkState): Promise<void> {
    const iface =
      runtime.activeInterfaces.find((i) => i.id === chunk.interfaceId) ??
      runtime.activeInterfaces[chunk.id]

    const controller = new AbortController()
    runtime.chunkRuntimes.set(chunk.id, { controller, partPath: '' })

    let attempt = 0

    while (runtime.state.status === 'downloading') {
      if (controller.signal.aborted) break

      // Atomically lease the next pending block in this event tick
      const block = runtime.blocks.find((b) => b.status === 'pending')
      if (!block) {
        // If other workers are still downloading, remain idle briefly in case a block fails and resets
        const anyStillDownloading = runtime.blocks.some((b) => b.status === 'downloading')
        if (anyStillDownloading) {
          chunk.speedBytesPerSec = 0
          this.scheduleUpdate(runtime)
          await delay(250, controller.signal).catch(() => {})
          continue
        }
        chunk.status = 'completed'
        chunk.speedBytesPerSec = 0
        this.scheduleUpdate(runtime)
        break
      }

      // Whoever held this block before now is the one whose tail bytes a truncation below
      // would discard — capture it before the lease overwrites the field.
      const previousWriter = block.interfaceId
      block.status = 'downloading'
      block.interfaceId = iface.id
      chunk.status = 'downloading'
      chunk.rangeStart = block.rangeStart
      chunk.rangeEnd = block.rangeEnd
      chunk.currentBlockIndex = block.index
      this.scheduleUpdate(runtime)

      const partPath = join(runtime.tempDir, `part-${block.index}`)
      const chunkRuntime = runtime.chunkRuntimes.get(chunk.id)
      if (chunkRuntime) {
        chunkRuntime.partPath = partPath
      }

      const resumeOffset = await reconcilePartFileSize(partPath, block.bytesDownloaded)
      if (resumeOffset !== block.bytesDownloaded) {
        block.bytesDownloaded = resumeOffset
        trimBlockAttribution(block, resumeOffset, previousWriter)
        this.recomputeAggregates(runtime)
      }

      if (block.rangeEnd !== null && block.rangeStart + resumeOffset > block.rangeEnd) {
        block.status = 'completed'
        block.interfaceId = iface.id
        this.recomputeAggregates(runtime)
        this.scheduleUpdate(runtime)
        continue
      }

      let lastReportedThisRun = 0

      try {
        await downloadChunk({
          url: runtime.requestPayload.url,
          rangeStart: block.rangeStart + resumeOffset,
          rangeEnd: block.rangeEnd,
          localAddress: iface.address,
          destinationPath: partPath,
          append: resumeOffset > 0,
          signal: controller.signal,
          onProgress: (bytesThisRun) => {
            const delta = bytesThisRun - lastReportedThisRun
            lastReportedThisRun = bytesThisRun
            if (delta > 0) {
              this.onWorkerProgress(runtime, chunk.id, block.index, iface.id, delta)
            }
          }
        })

        // Block finished successfully
        block.status = 'completed'
        block.interfaceId = iface.id
        if (block.rangeEnd !== null) {
          // Progress events can lag the final write, so square the block up to its exact size
          // and credit the shortfall to the network that finished it.
          const blockBytes = block.rangeEnd - block.rangeStart + 1
          creditBlockBytes(block, iface.id, blockBytes - block.bytesDownloaded)
          block.bytesDownloaded = blockBytes
        }
        attempt = 0
        this.recomputeAggregates(runtime)
        this.scheduleUpdate(runtime)
      } catch (error) {
        const currentStatus = runtime.state.status as DownloadStatus
        if (controller.signal.aborted || currentStatus !== 'downloading') {
          if (currentStatus === 'paused') {
            block.status = 'pending'
            chunk.status = 'paused'
          } else {
            chunk.status = 'cancelled'
          }
          chunk.speedBytesPerSec = 0
          break
        }

        const message = error instanceof Error ? error.message : String(error)
        chunk.error = message
        attempt += 1
        chunk.retryCount += 1

        // Return block back to queue so any available worker can pick it up
        block.status = 'pending'

        if (attempt > MAX_CHUNK_RETRIES) {
          chunk.status = 'error'
          chunk.speedBytesPerSec = 0
          const allErrored = runtime.state.chunks.every((c) => c.status === 'error')
          if (allErrored && (runtime.state.status as DownloadStatus) === 'downloading') {
            runtime.state.status = 'error'
            runtime.state.error = message
            for (const cr of runtime.chunkRuntimes.values()) {
              cr.controller.abort()
            }
          }
          break
        }

        chunk.status = 'retrying'
        this.scheduleUpdate(runtime)
        await delay(retryDelayMs(attempt), controller.signal).catch(() => {})
        const statusAfterDelay = runtime.state.status as DownloadStatus
        if (controller.signal.aborted || statusAfterDelay !== 'downloading') {
          chunk.status = statusAfterDelay === 'paused' ? 'paused' : 'cancelled'
          chunk.speedBytesPerSec = 0
          break
        }
        chunk.status = 'downloading'
      }
    }

    this.scheduleUpdate(runtime)
  }

  private onWorkerProgress(
    runtime: DownloadRuntime,
    chunkId: number,
    blockIndex: number,
    interfaceId: string,
    deltaBytes: number
  ): void {
    const chunk = runtime.state.chunks.find((entry) => entry.id === chunkId)
    const block = runtime.blocks[blockIndex]
    if (!chunk || !block) return

    chunk.bytesDownloaded += deltaBytes
    block.bytesDownloaded += deltaBytes
    creditBlockBytes(block, interfaceId, deltaBytes)
    chunk.currentBlockIndex = blockIndex

    const now = Date.now()
    let samples = runtime.speedSamplesByChunk.get(chunkId)
    if (!samples) {
      samples = []
      runtime.speedSamplesByChunk.set(chunkId, samples)
    }
    chunk.speedBytesPerSec = pushSpeedSample(samples, chunk.bytesDownloaded, now)

    // This runs on every socket data event, so it folds the delta in rather than re-summing
    // every block — that sum is O(blocks), and a large file has thousands of them. The other
    // callers of recomputeAggregates are rare enough to afford the full pass, and each one
    // re-derives the true total, so any drift here cannot accumulate.
    runtime.state.bytesDownloaded += deltaBytes
    runtime.state.speedBytesPerSec = sumChunkSpeeds(runtime)
    this.scheduleUpdate(runtime)
  }

  private recomputeAggregates(runtime: DownloadRuntime): void {
    runtime.state.bytesDownloaded = runtime.blocks.reduce(
      (sum, entry) => sum + entry.bytesDownloaded,
      0
    )
    runtime.state.speedBytesPerSec = sumChunkSpeeds(runtime)
  }

  /**
   * How often this download may push progress and rewrite its manifest.
   *
   * Both costs scale with the block count, because each one serializes the whole block array
   * — once through IPC to the renderer, once to disk. The HTTP engine caps itself at 4096
   * blocks by growing the block size, but a torrent's pieces are fixed by the torrent: a 6 GB
   * Ubuntu ISO is 24,729 of them. At the base interval that is megabytes a second of copying
   * to animate a grid the user cannot see individual cells in anyway, so large downloads
   * trade a little progress latency for not spending the download's time on bookkeeping.
   */
  private throttleFor(runtime: DownloadRuntime): number {
    return runtime.totalBlocks > 8192 ? PROGRESS_THROTTLE_MS * 5 : PROGRESS_THROTTLE_MS
  }

  private scheduleUpdate(runtime: DownloadRuntime): void {
    if (runtime.pushScheduled) return
    runtime.pushScheduled = true
    setTimeout(() => {
      runtime.pushScheduled = false
      this.pushUpdate(runtime)
    }, this.throttleFor(runtime))
  }

  private pushUpdate(runtime: DownloadRuntime, persist = true): void {
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

    const output = createWriteStream(runtime.state.destinationPath)
    let bytesWritten = 0

    // Attached before the first write, and kept for the stream's whole life:
    // destroying the output after a failed check can surface an in-flight
    // write as an 'error' event, and an unhandled 'error' on a stream takes
    // down the main process rather than failing this one download.
    const outputErrors: Error[] = []
    output.on('error', (error: Error) => outputErrors.push(error))

    try {
      for (let i = 0; i < runtime.totalBlocks; i++) {
        const partPath = join(runtime.tempDir, `part-${i}`)
        const block = runtime.blocks[i]
        const expectedBytes = block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1
        const actualBytes = (await stat(partPath)).size

        if (expectedBytes !== null && actualBytes !== expectedBytes) {
          throw new Error(
            `Part ${i} is ${actualBytes} bytes but should be ${expectedBytes} — refusing to write a corrupt file`
          )
        }

        await appendFileToStream(partPath, output)
        if (outputErrors.length > 0) throw outputErrors[0]
        bytesWritten += actualBytes
      }

      output.end()
      await finished(output)
      if (outputErrors.length > 0) throw outputErrors[0]

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

  /**
   * Releases the placeholder file reserved at start when the download won't be
   * filling it in, so its name is free for the next attempt. Only ever removes
   * a path this download created and never finished writing — a completed
   * download keeps its file.
   */
  private async discardUnfinishedDestination(runtime: DownloadRuntime): Promise<void> {
    if (runtime.state.status === 'completed') return
    try {
      // `recursive` for a multi-file torrent, whose reserved destination is a directory.
      await rm(runtime.state.destinationPath, { force: true, recursive: true })
    } catch {
      // Best-effort — a stray empty file isn't worth failing the download over.
    }
  }

  private async cleanupTempDir(runtime: DownloadRuntime): Promise<void> {
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
    }, this.throttleFor(runtime))
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
    await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
  }
}
