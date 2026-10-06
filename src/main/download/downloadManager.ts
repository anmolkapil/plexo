import { trashDownload } from './trashDownload'
import { describeError } from '../../shared/errors'
import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { BrowserWindow } from 'electron'
import { app, Notification, powerSaveBlocker, shell } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import {
  DOWNLOADS_AT_ONCE,
  SPEED_HISTORY_SECONDS,
  type AppSettings,
  type DownloadNetwork,
  type DownloadState,
  type DownloadStatus,
  type DownloadUnitState,
  type DownloadUpdate,
  type FinishedDownload,
  type HttpBlockState,
  type HttpDownloadNetwork,
  type HttpDownloadState,
  type NetworkInterfaceInfo,
  type NetworkStatus,
  type StartDownloadRequest,
  type StartHttpDownloadRequest,
  type StartTorrentDownloadRequest,
  type TorrentDownloadNetwork,
  type TorrentDownloadState,
  type TorrentFileEntry,
  type TorrentInfo,
  type TorrentPieceState
} from '../../shared/types'
import { Limits } from '../network/limits'
import { loadSettings } from '../settings'
import { addToHistory, findInHistory, removeFromHistory } from './history'
import { testKnobs } from '../testKnobs'
import { DownloadFile } from './downloadFile'
import { HttpTransfer, splittable } from './httpTransfer'
import { ensureDirectory, pathExists, reserveDestinationPath } from './paths'
import { planBlocks, planDownload, planPieces } from './plan'
import { restoreBlocks, restorePieces, saveBlocks, type SavedBlocks } from './savedProgress'
import { chosenFiles, finishedFiles, wantedPieces } from './torrent/files'
import { probeUrl } from './probe'
import { describeTorrent, probedTorrentFile } from './torrent/metadata'
import { TorrentDestination } from './torrent/torrentDestination'
import { TorrentTransfer } from './torrent/torrentTransfer'
import {
  clearSpeeds,
  delay,
  Meters,
  recomputeAggregates,
  updateSpeeds,
  updateTimeLeft,
  type Transfer,
  type TransferHost,
  type HttpTransferTarget,
  type TorrentTransferTarget
} from './transfer'
import type { NetworkMonitor } from '../network/interfaces'
import {
  compatibleInterfaces,
  NoCompatibleRouteError,
  resolveTargetWithin,
  targetHost
} from '../network/routes'

interface RuntimeFields {
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  runPromise?: Promise<void>
  cancelPromise?: Promise<void>
  publishing: boolean
  pushScheduled: boolean
  persistenceTimer?: NodeJS.Timeout
  persistenceChain: Promise<void>
  removed: boolean
  /** Updates sent to the window so far (see DownloadUpdate). */
  sentUpdates: number
  /** Each block as the window was last sent it, by index — what tells a changed block apart. */
  sentUnits: (Pick<DownloadUnitState, 'status' | 'interfaceId' | 'bytesDownloaded'> & {
    provisionalBytes?: number
  })[]
  /** The network most recently switched off: what a resume switches back on if it finds none on.
   * Not persisted: after a restart, the first network present is used instead. */
  lastSwitchedOff?: string
  /** Paused by switching off its last network, rather than by Pause: switching one back on
   * resumes it. */
  pausedForNoNetwork?: boolean
  /** When the speeds last went into the history (see sampleSpeeds). */
  speedSampledAt: number
  /** This run's byte count, read once a second from its start: the last PEAK_SECONDS + 1. */
  peakReadings: { time: number; bytes: number }[]
  /** Changes asked of a torrent's choice of files, counted: only the latest applies. */
  fileChoices: number
}

interface HttpDownloadRuntime extends RuntimeFields, HttpTransferTarget {
  kind: 'http'
  transfer: Transfer
}

interface TorrentDownloadRuntime extends RuntimeFields, TorrentTransferTarget {
  kind: 'torrent'
  transfer: TorrentTransfer
}

type DownloadRuntime = HttpDownloadRuntime | TorrentDownloadRuntime

interface PersistedDownloadBase {
  savedAt: number
  partialPath: string
  publicationPath?: string
  publicationIdentity?: { dev: number; ino: number }
  requestPayload: StartDownloadRequest
}

type PersistedState =
  Omit<HttpDownloadState, 'blocks' | 'streams'> | Omit<TorrentDownloadState, 'pieces' | 'peers'>

type PersistedDownload = PersistedDownloadBase & {
  version: 7
  state: PersistedState
} & SavedBlocks

const UI_UPDATE_MS = 200
/** How often a running download takes stock (see run). */
const TICK_MS = 500
// Syncing a growing file can briefly monopolize a slow destination drive. Keep recovery
// checkpoints independent of UI updates; pause and publication still force an immediate sync.
const CHECKPOINT_INTERVAL_MS = 15_000

// The peak is the best speed held this many seconds: longer than a start's burst (an ISP's burst
// allowance, every connection ramping up at once), which isn't the line's speed.
const PEAK_SECONDS = 5

/** Adds each network's speed to the download's history, and 0 for one no longer listed. A
 * network seen for the first time starts at 0 too, so every series is as long as the others and
 * lines up with them. */
function sampleSpeeds(state: DownloadState): void {
  const history = (state.speedHistory ??= {})
  const length = Object.values(history)[0]?.length ?? 0
  for (const network of state.networks) {
    history[network.id] ??= new Array<number>(length).fill(0)
  }
  for (const [id, series] of Object.entries(history)) {
    series.push(state.networks.find((network) => network.id === id)?.speedBytesPerSec ?? 0)
    if (series.length > SPEED_HISTORY_SECONDS) series.shift()
  }
}

/** Raises the peak to this run's last PEAK_SECONDS, read from the bytes themselves: what AVG is
 * made of, so the peak can't read below it (an average is never above its best stretch). Read off
 * the speed meters instead, it missed the opening burst AVG counts, and early on read lower. The
 * first stretch starts with the run, so a burst is in it, spread over the seconds, not a speed. */
function samplePeak(runtime: DownloadRuntime, now: number): void {
  const readings = runtime.peakReadings
  readings.push({ time: now, bytes: runtime.state.bytesDownloaded })
  if (readings.length > PEAK_SECONDS + 1) readings.shift()
  if (readings.length <= PEAK_SECONDS) return
  const first = readings[0]
  const held = (runtime.state.bytesDownloaded - first.bytes) / ((now - first.time) / 1000)
  runtime.state.peakSpeedBytesPerSec = Math.max(runtime.state.peakSpeedBytesPerSec ?? 0, held)
}

function newHttpNetwork(iface: NetworkInterfaceInfo, enabled: boolean): HttpDownloadNetwork {
  return {
    transfer: 'http',
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

function newTorrentNetwork(iface: NetworkInterfaceInfo, enabled: boolean): TorrentDownloadNetwork {
  return {
    ...newHttpNetwork(iface, enabled),
    transfer: 'torrent',
    bytesUploaded: 0,
    uploadSpeedBytesPerSec: 0
  }
}

/** A block that needs nothing more: in, or skipped (see BlockStatus). */
const isDone = (unit: DownloadUnitState): boolean =>
  unit.status === 'completed' || unit.status === 'skipped'

const unitsOf = (runtime: DownloadRuntime): DownloadUnitState[] =>
  runtime.kind === 'http' ? runtime.blocks : runtime.pieces

/** A torrent download's files as its state shows them, given those `chosen` (null: every one). */
function choiceOf(chosen: Set<number> | null, total: number): TorrentDownloadState['files'] {
  const selected = chosen ? [...chosen].sort((a, b) => a - b) : undefined
  return { chosen: selected?.length ?? total, total, selected }
}

/** Sets each piece of `torrent` by whether a `chosen` file (null: every one) needs it: skipped
 * when none does, waiting again when one does. A piece that's in stays in, needed or not. The
 * skipped pieces' bytes, all together. As a download starts, comes back, or its choice changes. */
function choosePieces(
  pieces: TorrentPieceState[],
  torrent: TorrentInfo,
  chosen: Set<number> | null
): number {
  const wanted = chosen && wantedPieces(torrent.files, torrent.pieceLength, chosen)
  let skipped = 0
  for (const piece of pieces) {
    if (piece.status === 'completed' || piece.rangeEnd === null) continue
    if (!wanted || wanted[piece.index]) {
      if (piece.status === 'skipped') piece.status = 'pending'
      continue
    }
    piece.status = 'skipped'
    piece.provisionalBytes = 0
    skipped += piece.rangeEnd - piece.rangeStart + 1
  }
  return skipped
}

/** The files not `chosen`, as the torrent names them. */
function unchosenPaths(torrent: TorrentInfo, chosen: Set<number> | null): string[] {
  return chosen
    ? torrent.files.filter((_, index) => !chosen.has(index)).map((file) => file.path)
    : []
}

const isNotFound = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** A manifest this version writes, for the download in folder `id`. */
function isCurrentManifest(value: unknown, id: string): value is PersistedDownload {
  const manifest = value as Partial<PersistedDownload> | null
  return manifest?.version === 7 && manifest.state?.id === id
}

/**
 * Where a saved download that can't be restored kept its partial data beside its destination:
 * only what is unmistakably Plexo's, so that a damaged manifest can never point it at a real file.
 * - A `<name>.plexo` staging file, or a torrent's `<name>.plexo/` staging folder.
 * - rc.1–rc.9 (manifest version 2) claimed the final name itself as an empty file, until the
 *   download's parts were joined into it: taken while it is still empty and the download
 *   unfinished, never once it holds anything.
 */
async function partialLeftovers(persisted: unknown): Promise<string[]> {
  const manifest = persisted as {
    version?: unknown
    partialPath?: unknown
    state?: { status?: unknown; destinationPath?: unknown }
  } | null
  const leftovers: string[] = []
  const partial = manifest?.partialPath
  if (typeof partial === 'string' && isAbsolute(partial)) {
    if (partial.endsWith('.plexo')) leftovers.push(partial)
    else if (dirname(partial).endsWith('.plexo')) leftovers.push(dirname(partial))
  }
  const placeholder = manifest?.state?.destinationPath
  if (
    manifest?.version === 2 &&
    manifest.state?.status !== 'completed' &&
    typeof placeholder === 'string' &&
    isAbsolute(placeholder)
  ) {
    const found = await lstat(placeholder).catch(() => null)
    if (found?.isFile() && found.size === 0) leftovers.push(placeholder)
  }
  return leftovers
}

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
  /** How many downloads may run at once; the rest wait, queued (see pump). */
  private downloadsAtOnce = DOWNLOADS_AT_ONCE.default
  /** Speed and data limits, for every download together. */
  readonly limits = new Limits(() => this.limitsChanged())

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor
  ) {
    this.initialization = Promise.all([
      this.restorePersistedDownloads(),
      this.limits.loaded,
      loadSettings().then((settings) => this.applySettings(settings))
    ]).then(() => {})
  }

  /** Takes up what the user set: how many run at once, and the limits. One running past a
   * lowered count is left to finish; a raised one starts the next ones in the queue. */
  applySettings(settings: AppSettings): void {
    this.downloadsAtOnce = settings.downloadsAtOnce ?? DOWNLOADS_AT_ONCE.default
    this.limits.configure(settings)
    this.limitsChanged()
    this.pump()
  }

  /** A network ran out of data, or a limit changed: each download's networks are looked at
   * again, so one at its limit stops being used, and one no longer at it is used again. */
  async resetNetworkUsage(id: string): Promise<void> {
    await this.limits.resetUsage(id)
    this.limitsChanged()
  }

  private limitsChanged(): void {
    for (const runtime of this.runtimes.values()) {
      const { status } = runtime.state
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      this.scheduleUpdate(runtime)
    }
  }

  private runningCount(): number {
    let running = 0
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status === 'downloading') running++
    }
    return running
  }

  /** Starts queued downloads, first queued first, while fewer than downloadsAtOnce run. Called
   * whenever one might have room: a run ended, a queued one went, the count went up. */
  private pump(): void {
    if (this.suspending) return
    const queued = [...this.runtimes.values()]
      .filter((runtime) => runtime.state.status === 'queued')
      .sort((a, b) => (a.state.queuedAt ?? 0) - (b.state.queuedAt ?? 0))
    for (const runtime of queued) {
      if (this.runningCount() >= this.downloadsAtOnce) return
      this.begin(runtime)
    }
  }

  /** Puts a download in the queue: at its end, or at its front when the user asked for it. */
  private enqueue(runtime: DownloadRuntime, front: boolean): void {
    const places = [...this.runtimes.values()]
      .filter((other) => other !== runtime && other.state.status === 'queued')
      .map((other) => other.state.queuedAt ?? 0)
    runtime.state.status = 'queued'
    // Time spent waiting isn't time spent downloading (begin adds it to totalPausedMs).
    runtime.state.pausedAt ??= Date.now()
    runtime.state.queuedAt = front
      ? Math.min(Date.now(), ...places) - 1
      : Math.max(Date.now(), ...places.map((place) => place + 1))
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

  /** Where a torrent download keeps its .torrent, beside its manifest. */
  private torrentFilePath(id: string): string {
    return join(this.downloadDir(id), 'metadata.torrent')
  }

  private runtimeFields(): RuntimeFields {
    return {
      publishing: false,
      pushScheduled: false,
      persistenceChain: Promise.resolve(),
      removed: false,
      sentUpdates: 0,
      sentUnits: [],
      speedSampledAt: 0,
      peakReadings: [],
      fileChoices: 0
    }
  }

  private newHttpRuntime(
    state: HttpDownloadState,
    requestPayload: StartHttpDownloadRequest,
    file: DownloadFile,
    blocks: HttpBlockState[]
  ): HttpDownloadRuntime {
    const target: HttpTransferTarget = {
      state,
      requestPayload,
      stop: new AbortController(),
      file,
      blocks,
      meters: new Meters()
    }
    const host: TransferHost = {
      networks: this.networks,
      limits: this.limits,
      reconcile: () => this.reconcile(runtime),
      failDownload: (message, discard) => this.failDownload(runtime, message, discard),
      failNetwork: (network, message) => this.failNetwork(runtime, network, message),
      scheduleUpdate: () => this.scheduleUpdate(runtime)
    }
    const runtime: HttpDownloadRuntime = Object.assign(target, this.runtimeFields(), {
      kind: 'http' as const,
      transfer: new HttpTransfer(target, host)
    })
    return runtime
  }

  private newTorrentRuntime(
    state: TorrentDownloadState,
    requestPayload: StartTorrentDownloadRequest,
    file: TorrentDestination,
    pieces: TorrentDownloadState['pieces'],
    torrentFile: Uint8Array
  ): TorrentDownloadRuntime {
    const target: TorrentTransferTarget = {
      state,
      requestPayload,
      stop: new AbortController(),
      file,
      pieces,
      meters: new Meters(),
      uploadMeters: new Meters()
    }
    const host: TransferHost = {
      networks: this.networks,
      limits: this.limits,
      reconcile: () => this.reconcile(runtime),
      failDownload: (message, discard) => this.failDownload(runtime, message, discard),
      failNetwork: (network, message) => this.failNetwork(runtime, network, message),
      scheduleUpdate: () => this.scheduleUpdate(runtime)
    }
    const runtime: TorrentDownloadRuntime = Object.assign(target, this.runtimeFields(), {
      kind: 'torrent' as const,
      transfer: new TorrentTransfer(target, host, torrentFile, file.path)
    })
    return runtime
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
        await rm(`${this.manifestPath(id)}.tmp`, { force: true }).catch(() => {})
        let persisted: unknown
        try {
          persisted = JSON.parse(await readFile(this.manifestPath(id), 'utf-8'))
        } catch (error) {
          // No manifest, or a garbled one: nothing can bring it back. Any other read error (a
          // drive not mounted, a permission) may pass, and is left for the next launch.
          if (error instanceof SyntaxError || isNotFound(error)) {
            await this.discardUnrestorable(id, undefined)
          }
          return
        }
        // Another version's, which this one doesn't read: rc.1–rc.9 kept parts in a folder of
        // their own (manifest version 2), later ones a different layout. Cleared, not kept forever.
        if (!isCurrentManifest(persisted, id)) return this.discardUnrestorable(id, persisted)
        try {
          const runtime = await this.restoreOne(id, persisted)
          if (runtime) restored.push(runtime)
          else await this.discardUnrestorable(id, persisted)
        } catch {
          // As above: left for a launch where it can be read.
        }
      })
    )

    // Two writing one partial file would scramble it: of any that share one, the newest is kept
    // and the others go, the file left to it.
    restored.sort((a, b) => b.state.startedAt - a.state.startedAt)
    const claimed = new Set<string>()
    const kept = restored.filter((runtime) => {
      if (claimed.has(runtime.file.path)) return false
      claimed.add(runtime.file.path)
      return true
    })
    await Promise.all(
      restored
        .filter((runtime) => !kept.includes(runtime))
        .map((runtime) => this.removePersistedDownload(runtime, false))
    )

    await Promise.all(
      kept.map(async (runtime) => {
        if (runtime.state.status === 'completed' && runtime.publicationIdentity) {
          const published = await stat(runtime.state.destinationPath).catch(() => null)
          if (
            published?.dev === runtime.publicationIdentity.dev &&
            published.ino === runtime.publicationIdentity.ino
          ) {
            await runtime.file.discardLeftover().catch(() => {})
          }
        }
        this.runtimes.set(runtime.state.id, runtime)
        // Finished before the relaunch (or found to be): history keeps it from here.
        if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
        else await this.persistNow(runtime)
      })
    )
  }

  /** A finished download leaves the list of running ones for history, with its work units: a
   * download that is done needs none of them. Its saved state goes only once history has it. */
  private async moveToHistory(runtime: DownloadRuntime): Promise<void> {
    let entry: FinishedDownload
    if (runtime.kind === 'http') {
      const { blocks: omittedBlocks, streams: omittedStreams, ...state } = runtime.state
      void omittedBlocks
      void omittedStreams
      entry = { ...state, unitsWritten: state.totalBlocks }
    } else {
      const { pieces, peers: omittedPeers, ...state } = runtime.state
      void omittedPeers
      const written = pieces.filter((piece) => piece.status !== 'skipped').length
      const files = await this.torrentFiles(state.id)
      entry = {
        ...state,
        unitsWritten: written,
        downloadedFiles: files
          .filter((file) => file.chosen)
          .map((file) =>
            state.folder ? file.path.split(/[\\/]/).slice(1).join(sep) : basename(file.path)
          )
      }
    }
    try {
      await addToHistory(structuredClone(entry))
    } catch {
      // Kept as it is, to be moved on the next launch.
      return
    }
    this.runtimes.delete(runtime.state.id)
    await this.removePersistedDownload(runtime, false)
    this.historyChanged()
  }

  private historyChanged(): void {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IpcChannels.historyChanged)
  }

  /** Forgets every finished download. Their files are the user's: they stay. */
  async clearHistory(): Promise<void> {
    await this.initialization
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => runtime.state.status === 'completed')
        .map((runtime) => runtime.runPromise)
    )
    await removeFromHistory()
    this.historyChanged()
  }

  /** A saved download as this version writes it, restored paused — or null when it never can
   * be: its progress doesn't fit its plan, or a torrent's .torrent is gone. */
  private async restoreOne(
    id: string,
    persisted: PersistedDownload
  ): Promise<DownloadRuntime | null> {
    const { requestPayload } = persisted
    const saved: SavedBlocks = { progress: persisted.progress, complete: persisted.complete }
    let state: DownloadState
    let runtime: DownloadRuntime
    if (persisted.state.kind === 'torrent' && requestPayload.kind === 'torrent') {
      const torrentFile = await readFile(this.torrentFilePath(id)).catch((error: unknown) => {
        if (isNotFound(error)) return null
        throw error
      })
      if (!torrentFile) return null
      const probe = await describeTorrent(torrentFile, requestPayload.url)
      if (probe.kind !== 'torrent') return null
      const { torrent } = probe
      const old = persisted.state
      const pieces = restorePieces(old, saved)
      if (!pieces) return null
      const chosen = chosenFiles(requestPayload.selectedFiles, torrent.files.length)
      state = {
        ...old,
        networks: old.networks.map((network) => ({ ...network, uploadSpeedBytesPerSec: 0 })),
        peers: [],
        pieces,
        totalPieces: pieces.length,
        pieceLength: torrent.pieceLength,
        files: choiceOf(chosen, torrent.files.length),
        // Its pieces no chosen file needs are skipped again.
        skippedBytes: choosePieces(pieces, torrent, chosen),
        uploadSpeedBytesPerSec: 0
      }
      runtime = this.newTorrentRuntime(
        state,
        requestPayload,
        new TorrentDestination(
          persisted.partialPath,
          state.totalBytes,
          unchosenPaths(torrent, chosen),
          torrent.files.map((file) => file.path)
        ),
        pieces,
        torrentFile
      )
    } else if (persisted.state.kind === 'http' && requestPayload.kind === 'http') {
      const old = persisted.state
      const blocks = restoreBlocks(old, saved)
      if (!blocks) return null
      state = { ...old, streams: [], blocks, totalBlocks: blocks.length }
      runtime = this.newHttpRuntime(
        state,
        requestPayload,
        new DownloadFile(persisted.partialPath),
        blocks
      )
    } else {
      return null
    }
    const units = unitsOf(runtime)
    // Nothing starts by itself after a relaunch: running or waiting, it comes back paused.
    if (state.status === 'downloading' || state.status === 'queued') {
      state.status = 'paused'
      state.pausedAt = persisted.savedAt || Date.now()
      state.queuedAt = undefined
    }
    clearSpeeds(state)
    for (const unit of units) {
      if (unit.status === 'downloading') unit.status = 'pending'
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }

    const file = runtime.file
    if (state.status === 'paused') {
      const size = await file.size().catch(() => -1)
      const publishedPath = persisted.publicationPath ?? state.destinationPath
      const published = await stat(publishedPath).catch(() => null)
      // A torrent's folder of files: its identity below is what tells it's this download's.
      const publishedSize = published?.isDirectory() ? state.totalBytes : (published?.size ?? -1)
      const expected = state.totalBytes || state.bytesDownloaded
      const sameFile =
        !!published &&
        (size >= 0
          ? await stat(file.path)
              .then((partial) => partial.dev === published.dev && partial.ino === published.ino)
              .catch(() => false)
          : persisted.publicationIdentity?.dev === published.dev &&
            persisted.publicationIdentity?.ino === published.ino)
      if (units.every(isDone) && publishedSize === expected && sameFile) {
        state.status = 'completed'
        state.destinationPath = publishedPath
        state.fileName = basename(publishedPath)
        state.error = undefined
        state.completedAt ??= persisted.savedAt
        if (size >= 0) await file.discardLeftover()
      } else if (size < 0) {
        state.status = 'error'
        state.error = 'The partial download file is missing. Remove this download and start again.'
        state.resumable = false
      } else {
        for (const unit of units) {
          const length = unit.rangeEnd === null ? 0 : unit.rangeEnd - unit.rangeStart + 1
          if (
            unit.rangeStart + unit.bytesDownloaded > size ||
            (unit.status === 'completed' && unit.bytesDownloaded !== length)
          ) {
            unit.status = 'pending'
            unit.bytesDownloaded = 0
            unit.bytesByInterface = {}
          }
        }
        state.bytesDownloaded = units.reduce((sum, unit) => sum + unit.bytesDownloaded, 0)
      }
    }

    runtime.publicationPath = persisted.publicationPath
    runtime.publicationIdentity = persisted.publicationIdentity
    // A resumed download's last minute starts when it does, not where it stopped before the
    // relaunch; a finished one keeps its chart.
    if (state.status !== 'completed') state.speedHistory = undefined
    recomputeAggregates(state, units)
    return runtime
  }

  /**
   * Clears a saved download that can't be restored, rather than keep it forever: its folder here
   * (manifest, a saved .torrent, an old version's parts/ folder), and its partial data beside the
   * destination when that is unmistakably Plexo's (see partialLeftovers).
   */
  private async discardUnrestorable(id: string, persisted: unknown): Promise<void> {
    for (const path of await partialLeftovers(persisted)) {
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }
    await rm(this.downloadDir(id), { recursive: true, force: true }).catch(() => {})
  }

  /** A snapshot of every download: updates with every work unit in them, oldest first. */
  async listDownloads(): Promise<DownloadUpdate[]> {
    await this.initialization
    return [...this.runtimes.values()]
      .sort((a, b) => a.state.startedAt - b.state.startedAt)
      .map((runtime) => {
        if (runtime.kind === 'http') {
          const { blocks, ...state } = runtime.state
          return structuredClone({ seq: runtime.sentUpdates, state, blocks })
        }
        const { pieces, ...state } = runtime.state
        return structuredClone({ seq: runtime.sentUpdates, state, pieces })
      })
  }

  async start(requestPayload: StartDownloadRequest): Promise<string> {
    await this.initialization

    const available = await this.networks.refresh()
    const selected = available.filter((iface) => requestPayload.interfaceIds.includes(iface.id))
    if (selected.length === 0) {
      throw new Error('Select at least one network')
    }
    await ensureDirectory(requestPayload.destinationDir)
    const id = randomUUID()
    let runtime: DownloadRuntime
    if (requestPayload.kind === 'torrent') {
      const torrentFile = probedTorrentFile(requestPayload.infoHash)
      if (!torrentFile) throw new Error('Add the torrent again to start downloading.')
      const torrentProbe = await describeTorrent(torrentFile, requestPayload.url)
      if (torrentProbe.kind !== 'torrent') throw new Error('Invalid torrent metadata')
      const torrent = torrentProbe.torrent
      const totalBytes = torrent.files.reduce((sum, entry) => sum + entry.length, 0)
      const chosen = chosenFiles(requestPayload.selectedFiles, torrent.files.length)
      const pieces = planPieces(totalBytes, torrent.pieceLength)
      const skippedBytes = choosePieces(pieces, torrent, chosen)
      await ensureDiskSpace(requestPayload.destinationDir, totalBytes - skippedBytes)
      const folder = torrent.files[0].path.includes(sep)
      const file = await TorrentDestination.create(
        requestPayload.destinationDir,
        requestPayload.suggestedFileName,
        folder,
        totalBytes,
        unchosenPaths(torrent, chosen),
        torrent.files.map((file) => file.path)
      )
      const destinationPath = file.path
      await ensureDirectory(this.downloadDir(id))
      await writeFile(this.torrentFilePath(id), torrentFile)
      const state: TorrentDownloadState = {
        id,
        kind: 'torrent',
        files: choiceOf(chosen, torrent.files.length),
        folder,
        url: requestPayload.url,
        fileName: basename(destinationPath),
        destinationPath,
        totalBytes,
        skippedBytes,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        bytesUploaded: 0,
        uploadSpeedBytesPerSec: 0,
        status: 'downloading',
        networks: available.map((iface) => newTorrentNetwork(iface, selected.includes(iface))),
        peers: [],
        peakPeers: 0,
        pieces,
        totalPieces: pieces.length,
        pieceLength: torrent.pieceLength,
        startedAt: Date.now()
      }
      runtime = this.newTorrentRuntime(state, requestPayload, file, pieces, torrentFile)
    } else {
      const target = new URL(requestPayload.url)
      const usable = compatibleInterfaces(
        selected,
        await resolveTargetWithin(targetHost(target), testKnobs.stallTimeoutMs)
      )
      if (usable.length === 0) throw new NoCompatibleRouteError(targetHost(target))
      const blockSizeBytes = planDownload({
        totalBytes: requestPayload.totalBytes,
        splittable: requestPayload.supportsRanges,
        networkCount: usable.length,
        maxBlockBytes: testKnobs.blockBytes
      }).blockSizeBytes
      const blocks = planBlocks(requestPayload.totalBytes, blockSizeBytes)
      await ensureDiskSpace(requestPayload.destinationDir, requestPayload.totalBytes)
      const destinationPath = await reserveDestinationPath(
        requestPayload.destinationDir,
        requestPayload.suggestedFileName
      )
      const networks = available.map((iface) => newHttpNetwork(iface, usable.includes(iface)))
      if (!splittable(requestPayload)) {
        for (const network of networks) network.enabled &&= network.id === usable[0].id
        for (const network of networks) network.status = network.enabled ? 'on' : 'off'
      }
      const state: HttpDownloadState = {
        id,
        kind: 'http',
        url: requestPayload.url,
        fileName: basename(destinationPath),
        destinationPath,
        totalBytes: requestPayload.totalBytes,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'downloading',
        networks,
        streams: [],
        peakStreams: 0,
        blocks,
        totalBlocks: blocks.length,
        blockSizeBytes,
        startedAt: Date.now()
      }
      runtime = this.newHttpRuntime(
        state,
        requestPayload,
        new DownloadFile(`${destinationPath}.plexo`),
        blocks
      )
    }
    // Decided only now: other starts may have taken the room while this one was set up.
    const room = this.runningCount() < this.downloadsAtOnce
    if (!room) this.enqueue(runtime, false)
    this.runtimes.set(id, runtime)
    await this.persistNow(runtime)
    this.pushUpdate(runtime)
    if (room) this.launch(runtime)

    return id
  }

  /** Runs the download, and once the run ends makes room for the next one queued. */
  private launch(runtime: DownloadRuntime): void {
    runtime.runPromise = this.run(runtime).finally(() => this.pump())
  }

  async pause(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'queued') {
      runtime.state.status = 'paused'
      runtime.state.queuedAt = undefined
      runtime.state.pausedAt ??= Date.now()
      this.pushUpdate(runtime)
      await this.persistNow(runtime)
      return
    }
    if (!runtime || runtime.state.status !== 'downloading' || runtime.publishing) return

    runtime.state.status = 'paused'
    runtime.state.pausedAt = Date.now()
    clearSpeeds(runtime.state)
    if (runtime.kind === 'http') {
      for (const stream of runtime.state.streams) {
        if (stream.status !== 'completed') {
          stream.status = 'paused'
        }
        stream.currentBlockIndex = undefined
        stream.hedge = undefined
      }
    }
    for (const unit of unitsOf(runtime)) {
      if (unit.status === 'downloading') {
        unit.status = 'pending'
      }
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }
    runtime.transfer.reset()
    this.stopRun(runtime)
    this.pushUpdate(runtime)
    await runtime.runPromise
    await this.persistNow(runtime)
  }

  /** Gives a download whose link stopped working (a signed link ran out, say) a fresh link to the
   * same file, and resumes it from where it stopped. The file must be as big as before; whether
   * its bytes are the same is checked as on any resume (see HttpTransfer's version check). */
  async relink(id: string, url: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'http') throw new Error('Only web downloads support replacing a link.')
    const { status, resumable, totalBytes } = runtime.state
    if (status !== 'error' && status !== 'paused') {
      throw new Error('Pause the download before replacing its link.')
    }
    if (resumable === false) throw new Error('This download can’t resume. Start it again.')
    const probe = await probeUrl(url)
    if (probe.kind !== 'http') throw new Error('That isn’t a link to a file')
    if ((probe.totalBytes ?? 0) !== totalBytes) {
      throw new Error(
        `That link is to a different file: ${formatGigabytes(probe.totalBytes ?? 0)}, not ${formatGigabytes(totalBytes)}`
      )
    }
    if (splittable(runtime.requestPayload) && !probe.supportsRanges) {
      throw new Error(
        'This server doesn’t support resuming downloads. Try another link to the same file.'
      )
    }
    runtime.requestPayload.url = probe.finalUrl
    runtime.state.url = probe.finalUrl
    await this.persistNow(runtime)
    this.resume(id)
  }

  resume(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.cancelPromise) return
    const { status, resumable } = runtime.state
    if (status !== 'paused' && !(status === 'error' && resumable !== false)) return

    void this.resumeAfterVerifying(runtime, false)
  }

  // A file that changed on the server while this download was paused is caught by the first
  // chunk request after resuming: its response is checked against the version the download
  // started on (see runWorker), which can tell a real change from a relabelled server. Whether a
  // network is there to resume on is the run's business: with none, it waits for one.
  // `byNetwork`: resumed by switching a network back on, rather than by Resume.
  private async resumeAfterVerifying(runtime: DownloadRuntime, byNetwork: boolean): Promise<void> {
    // The paused run can still be winding down: a writer closing, a sample check in flight. A new
    // one must not start beside it — both would go on to publish, and act on each other's streams.
    await runtime.runPromise
    // Just after launch the networks may not have been looked at yet.
    await this.networks.refresh()

    if ((await runtime.file.size().catch(() => -1)) < 0) {
      runtime.state.error =
        'The partial download file is unavailable. Reconnect the destination drive and try again.'
      this.pushUpdate(runtime)
      return
    }
    if (
      runtime.cancelPromise ||
      (runtime.state.status !== 'paused' && runtime.state.status !== 'error')
    )
      return
    const { networks } = runtime.state
    // Switched back on, then off again while the paused run wound down: it stays paused.
    if (byNetwork && !networks.some((network) => network.enabled)) return

    if (this.runningCount() >= this.downloadsAtOnce) {
      // Asked for by name, so it goes next.
      this.enqueue(runtime, true)
      runtime.state.error = undefined
      runtime.state.resumable = undefined
      runtime.pausedForNoNetwork = undefined
      this.pushUpdate(runtime)
      return
    }
    this.begin(runtime)
  }

  /** Starts a run of a paused, failed or queued download, from where it stopped. */
  private begin(runtime: DownloadRuntime): void {
    const { networks } = runtime.state
    runtime.state.status = 'downloading'
    runtime.state.queuedAt = undefined
    runtime.state.error = undefined
    runtime.state.resumable = undefined
    runtime.pausedForNoNetwork = undefined
    // Paused by switching off every network: resuming switches back on the one switched off
    // last if it is still there, or else the first one present.
    if (!networks.some((network) => network.enabled)) {
      const present = (network: { id: string }): boolean => !!this.networks.find(network.id)
      const again =
        networks.find((network) => network.id === runtime.lastSwitchedOff && present(network)) ??
        networks.find(present) ??
        networks.find((network) => network.id === runtime.lastSwitchedOff) ??
        networks[0]
      if (again) again.enabled = true
    }
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
    for (const unit of unitsOf(runtime)) {
      if (unit.status === 'downloading') {
        unit.status = 'pending'
      }
      if (unit.kind === 'torrent') unit.provisionalBytes = 0
    }
    if (runtime.kind === 'http') {
      for (const stream of runtime.state.streams) {
        if (stream.status !== 'completed') {
          stream.status = 'pending'
        }
        stream.speedBytesPerSec = 0
      }
    } else {
      runtime.state.peers.length = 0
    }
    runtime.transfer.reset()
    this.pushUpdate(runtime)

    this.launch(runtime)
  }

  /** Switches one of a download's networks on or off, running or paused. Switching off the last
   * network in use pauses the download; switching one back on then resumes it. */
  async setNetworkEnabled(id: string, networkId: string, enabled: boolean): Promise<void> {
    const runtime = this.runtimes.get(id)
    const status = runtime?.state.status
    if (
      !runtime ||
      runtime.cancelPromise ||
      (status !== 'downloading' && status !== 'paused' && status !== 'queued')
    ) {
      return
    }
    const { networks } = runtime.state
    const network = networks.find((entry) => entry.id === networkId)
    if (!network || network.enabled === enabled) return
    const wasLast = !enabled && !networks.some((other) => other !== network && other.enabled)
    // A download that can't be split runs over one network: switching one on switches it over.
    if (enabled && runtime.kind === 'http' && !splittable(runtime.requestPayload)) {
      for (const other of networks) other.enabled = false
    }
    network.enabled = enabled
    if (!enabled) runtime.lastSwitchedOff = network.id
    if (wasLast && status === 'downloading') {
      runtime.pausedForNoNetwork = true
      await this.pause(id)
      // Not paused after all (it was already publishing): nothing for a network to resume.
      if (runtime.state.status !== 'paused') runtime.pausedForNoNetwork = undefined
      return
    }
    this.reconcile(runtime)
    this.pushUpdate(runtime)
    // Switched back on while the pause is still winding down, it resumes once that is done.
    if (enabled && status === 'paused' && runtime.pausedForNoNetwork) {
      void this.resumeAfterVerifying(runtime, true)
    }
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
      if (status !== 'downloading' && status !== 'paused' && status !== 'queued') continue
      this.reconcile(runtime)
      runtime.transfer.wake(
        (id) => changed.has(id),
        (id) => moved.has(id)
      )
      this.scheduleUpdate(runtime)
    }
  }

  /** The computer woke from sleep. Its sockets are likely dead, though nothing will say so until
   * a stall watchdog runs out, and every judgement made by the clock (a silent network, a
   * crawling connection) spans the sleep. All of it starts over. */
  systemResumed(): void {
    const now = Date.now()
    for (const runtime of this.runtimes.values()) {
      if (runtime.state.status !== 'downloading') continue
      runtime.transfer.systemResumed(now)
    }
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

  /** A torrent download's own .torrent, read: its files never change, so they're read when
   * needed rather than kept or sent with every update. */
  private async torrentInfo(id: string): Promise<TorrentInfo | null> {
    const request = this.runtimes.get(id)?.requestPayload
    if (request?.kind !== 'torrent') return null
    const probe = await describeTorrent(await readFile(this.torrentFilePath(id)), request.url)
    return probe.kind === 'torrent' ? probe.torrent : null
  }

  /** A torrent download's files, each marked by whether it's chosen. */
  async torrentFiles(id: string): Promise<TorrentFileEntry[]> {
    const torrent = await this.torrentInfo(id)
    const request = this.runtimes.get(id)?.requestPayload
    if (!torrent || request?.kind !== 'torrent') return []
    const chosen = chosenFiles(request.selectedFiles, torrent.files.length)
    return torrent.files.map((file, index) => ({ ...file, chosen: !chosen || chosen.has(index) }))
  }

  /** Changes which of a torrent download's files it fetches, running or not, as its choice
   * (requestPayload.selectedFiles) everything else follows from. What's in stays in: the pieces
   * a newly chosen file needs are fetched, those no chosen file needs any more aren't. A file
   * that's in can't be dropped: it's done, and dropping it would delete it once the download is. */
  async chooseTorrentFiles(id: string, selected: number[]): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.kind !== 'torrent') throw new Error('This download has no files to choose')
    // Ticks come quicker than the disk answers: one overtaken by a later one gives way to it.
    const turn = ++runtime.fileChoices
    const torrent = await this.torrentInfo(id)
    if (!torrent) throw new Error('This download has no files to choose')
    // Done or going: its files are what they are. Checked again after waiting on the disk.
    const settled = (): boolean =>
      runtime.publishing ||
      runtime.state.status === 'completed' ||
      runtime.state.status === 'cancelled' ||
      this.runtimes.get(id) !== runtime
    if (settled()) throw new Error('This download’s files can’t change now')

    const chosen = chosenFiles(selected, torrent.files.length)
    const completed = runtime.pieces.map((piece) => piece.status === 'completed')
    const finished = finishedFiles(torrent.files, torrent.pieceLength, completed)
    if (chosen && [...finished].some((index) => !chosen.has(index))) {
      throw new Error('A file that’s already downloaded stays')
    }
    const wanted = chosen && wantedPieces(torrent.files, torrent.pieceLength, chosen)
    let adding = 0
    for (const piece of runtime.pieces) {
      if (piece.status === 'skipped' && (!wanted || wanted[piece.index])) {
        adding += piece.rangeEnd! - piece.rangeStart + 1
      }
    }
    await ensureDiskSpace(runtime.requestPayload.destinationDir, adding)
    if (settled()) throw new Error('This download’s files can’t change now')
    if (turn !== runtime.fileChoices) return

    runtime.state.files = choiceOf(chosen, torrent.files.length)
    runtime.requestPayload.selectedFiles = runtime.state.files.selected
    runtime.state.skippedBytes = choosePieces(runtime.pieces, torrent, chosen)
    runtime.file.unwanted = unchosenPaths(torrent, chosen)
    runtime.transfer.filesChosen()
    // Sent now, ahead of the answer: the window shows the choice from the state it's sent.
    this.pushUpdate(runtime)
  }

  async cancel(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime?.cancelPromise) return runtime.cancelPromise
    if (
      !runtime ||
      runtime.publishing ||
      (runtime.state.status !== 'downloading' &&
        runtime.state.status !== 'paused' &&
        runtime.state.status !== 'queued' &&
        runtime.state.status !== 'error')
    )
      return

    runtime.cancelPromise = this.cancelRuntime(runtime)
    try {
      await runtime.cancelPromise
    } finally {
      runtime.cancelPromise = undefined
    }
  }

  private async cancelRuntime(runtime: DownloadRuntime): Promise<void> {
    try {
      // Stop writing first, but keep the item visible until its files and manifest are gone.
      await this.pause(runtime.state.id)
      if (runtime.state.status !== 'error') {
        runtime.state.status = 'paused'
        runtime.state.queuedAt = undefined
        runtime.state.pausedAt ??= Date.now()
      }
      clearSpeeds(runtime.state)
      this.stopRun(runtime)
      this.pushUpdate(runtime, false)
      await runtime.runPromise?.catch(() => {})
      await runtime.file.discard()
      await this.removePersistedDownload(runtime, false)
      runtime.state.status = 'cancelled'
      if (runtime.kind === 'http') {
        for (const stream of runtime.state.streams) stream.status = 'cancelled'
      }
      this.pushUpdate(runtime, false)
    } catch (error) {
      runtime.removed = false
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      // Cleanup may have removed only some files: retry cancellation rather than resuming them.
      runtime.state.resumable = false
      this.pushUpdate(runtime, false)
      await this.persistNow(runtime)
      throw error
    } finally {
      // A queued one never ran, so no run's end makes room after it.
      this.pump()
    }
  }

  /** Removes a download, cancelling one under way. A finished one's file stays where it is,
   * unless `trashFile`: then it goes to the Trash, where the user can still get it back. The
   * path is the download's own, never one the window names. */
  async remove(id: string, trashFile = false): Promise<void> {
    await this.initialization
    let runtime = this.runtimes.get(id)
    if (runtime?.state.status === 'completed') {
      // Completion is shown before history is saved. Let that move finish before choosing
      // whether to remove a live runtime or a history entry, including for torrent file removal.
      await runtime.runPromise?.catch(() => {})
      runtime = this.runtimes.get(id)
    }
    if (
      runtime &&
      (runtime.state.status === 'downloading' ||
        runtime.state.status === 'paused' ||
        runtime.state.status === 'queued' ||
        runtime.state.status === 'error')
    ) {
      await this.cancel(id)
    }
    if (runtime) {
      if (trashFile && runtime.state.status === 'completed') {
        const owned =
          runtime.kind === 'torrent'
            ? (await this.torrentFiles(id))
                .filter((file) => file.chosen)
                .map((file) => file.path.split(/[\\/]/).slice(1).join(sep))
            : undefined
        await trashDownload(runtime.state, owned)
      }
      this.runtimes.delete(id)
      await this.removePersistedDownload(runtime)
      if (runtime.state.status === 'completed') {
        await removeFromHistory([id])
        this.historyChanged()
      }
      return
    }
    // A finished one, from history.
    const entry = trashFile ? await findInHistory(id) : undefined
    if (entry && !entry.missing) await trashDownload(entry)
    await removeFromHistory([id])
    this.historyChanged()
  }

  /** Shows a download's file in its folder: by the download's own path, never one the window
   * names, and only once it's checked to be there — the window's view of that can be old (the
   * file moved or deleted since). When it isn't, the window is told to look again, and the
   * history it gets marks it missing. */
  async reveal(id: string): Promise<boolean> {
    const download = this.runtimes.get(id)?.state ?? (await findInHistory(id))
    const path = download?.destinationPath
    if (path && (await pathExists(path).catch(() => false))) {
      shell.showItemInFolder(path)
      return true
    }
    this.historyChanged()
    return false
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
    await this.limits.save()
  }

  /**
   * Runs the download until every block is in, or it is stopped. Each TICK_MS, and whenever a
   * stream ends, it takes stock: speeds, stuck connections, which networks run streams (see
   * reconcile) and how many (see concurrency.ts). With no network to use, it waits for one.
   */
  private async run(runtime: DownloadRuntime): Promise<void> {
    if (runtime.stop.signal.aborted) runtime.stop = new AbortController()
    runtime.transfer.reset()
    // Speeds are this run's: nothing carries over from the last one.
    runtime.meters.clear()
    if (runtime.kind === 'torrent') runtime.uploadMeters.clear()
    const { signal } = runtime.stop
    this.reconcile(runtime)
    // One watcher per stream for its whole life. Racing every stream each tick would pile a
    // handler per tick onto each one still running, held until it ends.
    const watched = new WeakSet<Promise<void>>()
    let wake: { resolve: () => void; reject: (error: unknown) => void } | null = null
    let tickedAt = Date.now()
    runtime.peakReadings = [{ time: tickedAt, bytes: runtime.state.bytesDownloaded }]

    while (
      runtime.state.status === 'downloading' &&
      unitsOf(runtime).some((unit) => !isDone(unit))
    ) {
      await new Promise<void>((resolve, reject) => {
        wake = { resolve, reject }
        for (const worker of runtime.transfer.running()) {
          if (watched.has(worker)) continue
          watched.add(worker)
          worker.then(
            () => wake?.resolve(),
            (error) => wake?.reject(error)
          )
        }
        void delay(TICK_MS, signal).then(resolve)
      })
      if ((runtime.state.status as DownloadStatus) !== 'downloading') break
      const now = Date.now()
      // The only place speeds are read: on this clock, never as bytes arrive (see Meter).
      const speedsChanged = updateSpeeds(runtime, now)
      const timeLeftChanged = updateTimeLeft(runtime.state, (now - tickedAt) / 1000)
      tickedAt = now
      if (speedsChanged || timeLeftChanged) this.scheduleUpdate(runtime)
      if (now - runtime.speedSampledAt >= 1000) {
        runtime.speedSampledAt = now
        sampleSpeeds(runtime.state)
        samplePeak(runtime, now)
        this.scheduleUpdate(runtime)
      }
      runtime.transfer.tick(now)
    }
    // The last blocks are in, or the run was stopped: its streams wind down.
    runtime.stop.abort()
    await Promise.all(runtime.transfer.running())
    // However it ended — paused, failed, cancelled, done — nothing is moving now.
    clearSpeeds(runtime.state)

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
      if (unitsOf(runtime).some((unit) => !isDone(unit))) {
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
      // Done before it ran PEAK_SECONDS: its run's own speed, start to finish, is the best it held.
      const [start] = runtime.peakReadings
      const ranFor = start ? (Date.now() - start.time) / 1000 : 0
      if (ranFor > 0) {
        runtime.state.peakSpeedBytesPerSec ??=
          (runtime.state.bytesDownloaded - start.bytes) / ranFor
      }
      runtime.state.bytesDownloaded =
        runtime.state.totalBytes -
          (runtime.state.kind === 'torrent' ? runtime.state.skippedBytes : 0) ||
        runtime.state.bytesDownloaded
      await this.persistNow(runtime)
      await runtime.file.discardLeftover().catch(() => {})
      this.notify('Download complete', `${runtime.state.fileName} has finished downloading.`)
    } catch (error) {
      runtime.state.status = 'error'
      runtime.state.error = error instanceof Error ? error.message : String(error)
      this.notify(
        'Download failed',
        `${runtime.state.fileName}: ${describeError(runtime.state.error)}`
      )
    }
    runtime.publishing = false

    this.pushUpdate(runtime)
    if (runtime.state.status === 'completed') await this.moveToHistory(runtime)
  }

  /** Stops the current run: every stream, and the run's own wait. */
  private stopRun(runtime: DownloadRuntime): void {
    runtime.stop.abort()
    runtime.transfer.abort()
  }

  /** Ends the download in an error. What it has downloaded stays for a resume, unless
   * `discard`: bytes that are no use any more. */
  private failDownload(runtime: DownloadRuntime, message: string, discard = false): void {
    if (runtime.state.status !== 'downloading') return
    runtime.state.status = 'error'
    runtime.state.error = message
    runtime.state.resumable = !discard
    this.notify('Download failed', `${runtime.state.fileName}: ${describeError(message)}`)
    this.stopRun(runtime)
  }

  /** The server keeps refusing requests over this network: it stops being used until the user
   * switches it off and on, it reconnects, or the download is resumed. */
  private failNetwork(runtime: DownloadRuntime, network: DownloadNetwork, message: string): void {
    network.status = 'failed'
    network.error = message
    this.reconcile(runtime)
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
   * Streams, while the download runs, are the transfer's (see HttpTransfer.reconcile).
   */
  private reconcile(runtime: DownloadRuntime): void {
    const { state } = runtime
    const present = this.networks.current
    // Until the monitor has looked, nothing is known to be gone.
    const known = present !== null
    if (known) {
      if (state.kind === 'http') {
        state.networks = state.networks.filter(
          (network) =>
            network.enabled ||
            network.bytesDownloaded > 0 ||
            present.some((iface) => iface.id === network.id) ||
            state.streams.some((stream) => stream.interfaceId === network.id)
        )
      } else {
        state.networks = state.networks.filter(
          (network) =>
            network.enabled ||
            network.bytesDownloaded > 0 ||
            network.bytesUploaded > 0 ||
            present.some((iface) => iface.id === network.id) ||
            state.peers.some((peer) => peer.interfaceId === network.id)
        )
      }
      for (const iface of present) {
        if (!state.networks.some((network) => network.id === iface.id)) {
          if (state.kind === 'http') state.networks.push(newHttpNetwork(iface, false))
          else state.networks.push(newTorrentNetwork(iface, false))
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
          : this.limits.limitReached(network.id)
            ? 'limit'
            : network.status === 'off' || network.status === 'offline' || network.status === 'limit'
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

    runtime.transfer.reconcile()
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

  /** What the window hasn't been sent yet: the download's state, and the work units that moved. */
  private takeUpdate(runtime: DownloadRuntime): DownloadUpdate {
    if (runtime.kind === 'http') {
      const changed = this.changedUnits(runtime, runtime.blocks)
      const { blocks: omittedBlocks, ...state } = runtime.state
      void omittedBlocks
      return structuredClone({ seq: ++runtime.sentUpdates, state, blocks: changed })
    }
    const changed = this.changedUnits(runtime, runtime.pieces)
    const { pieces: omittedPieces, ...state } = runtime.state
    void omittedPieces
    return structuredClone({ seq: ++runtime.sentUpdates, state, pieces: changed })
  }

  private changedUnits<T extends DownloadUnitState>(runtime: DownloadRuntime, units: T[]): T[] {
    const sent = runtime.sentUnits
    const changed: T[] = []
    for (const unit of units) {
      const last = sent[unit.index]
      if (
        last?.status === unit.status &&
        last.interfaceId === unit.interfaceId &&
        last.bytesDownloaded === unit.bytesDownloaded &&
        last.provisionalBytes === (unit.kind === 'torrent' ? unit.provisionalBytes : undefined)
      ) {
        continue
      }
      sent[unit.index] = {
        status: unit.status,
        interfaceId: unit.interfaceId,
        bytesDownloaded: unit.bytesDownloaded,
        provisionalBytes: unit.kind === 'torrent' ? unit.provisionalBytes : undefined
      }
      changed.push(unit)
    }
    return changed
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
        let state: PersistedState
        if (runtime.kind === 'http') {
          const { blocks: omittedBlocks, streams: omittedStreams, ...rest } = runtime.state
          void omittedBlocks
          void omittedStreams
          state = rest
        } else {
          const { pieces: omittedPieces, peers: omittedPeers, ...rest } = runtime.state
          void omittedPieces
          void omittedPeers
          state = rest
        }
        const persisted: PersistedDownload = {
          version: 7,
          savedAt: Date.now(),
          state: structuredClone(state),
          ...saveBlocks(unitsOf(runtime)),
          partialPath: runtime.file.path,
          publicationPath: runtime.publicationPath,
          publicationIdentity: runtime.publicationIdentity,
          requestPayload: runtime.requestPayload
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
    // A finished download is the user's now: only what's left of it goes.
    if (discardPartial) {
      const file = runtime.file
      await (runtime.state.status === 'completed' ? file.discardLeftover() : file.discard()).catch(
        () => {}
      )
    }
    await rm(this.downloadDir(runtime.state.id), { recursive: true, force: true })
  }
}
