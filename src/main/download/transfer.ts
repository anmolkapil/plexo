import type {
  DownloadNetwork,
  DownloadState,
  DownloadUnitState,
  HttpBlockState,
  HttpDownloadState,
  StartHttpDownloadRequest,
  StartTorrentDownloadRequest,
  TorrentDownloadState,
  TorrentPieceState
} from '../../shared/types'
import type { NetworkMonitor } from '../network/interfaces'
import type { Limits } from '../network/limits'
import type { DownloadFile } from './downloadFile'
import type { TorrentDestination } from './torrent/torrentDestination'

/**
 * How a download's bytes get fetched: HTTP streams today (see httpTransfer.ts). The manager runs
 * everything a download does whatever fetches it — its networks, pause and resume, saving it,
 * telling the window — and hands the fetching to its transfer.
 */
export interface Transfer {
  /** Brings its connections in line with what each network can do now. The manager calls it at
   * the end of its own reconcile, while the download runs. */
  reconcile(): void
  /** Runs every TICK_MS while the download does. */
  tick(now: number): void
  /** Its connections' work, each settling once that connection stops: the run waits on them. */
  running(): Iterable<Promise<void>>
  /** Stops every connection: a pause, a cancel, a failed download. */
  abort(): void
  /** Forgets what only steers the current run. Done on a pause, a resume and as a run starts. */
  reset(): void
  /** Gets connections going again now, rather than when their backoff runs out: what held them
   * back has changed. The ones `reconnect` picks also drop their sockets. */
  wake(pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void
  /** The computer woke from sleep: every judgement made by the clock starts over. */
  systemResumed(now: number): void
}

/** The parts of a download a transfer works on. The manager owns them; this is the same object. */
interface TransferTargetBase {
  file: DownloadFile
  /** Aborted once the current run is over — stopped (a pause, a cancel, an error) or every
   * block in — so nothing starts streams for it and no stream waits on. */
  stop: AbortController
}

export interface HttpTransferTarget extends TransferTargetBase {
  state: HttpDownloadState
  requestPayload: StartHttpDownloadRequest
  blocks: HttpBlockState[]
  /** What each stream, and each network, has received (see updateSpeeds). */
  meters: Meters
}

export interface TorrentTransferTarget extends TransferTargetBase {
  file: TorrentDestination
  state: TorrentDownloadState
  requestPayload: StartTorrentDownloadRequest
  pieces: TorrentPieceState[]
  /** What each peer, and each network, has received (see updateSpeeds). */
  meters: Meters
  /** What each peer, and each network, has sent. */
  uploadMeters: Meters
}

export type TransferTarget = HttpTransferTarget | TorrentTransferTarget

/** What a transfer asks of the manager. */
export interface TransferHost {
  networks: NetworkMonitor
  /** Every byte received goes through it (see Limits.take). */
  limits: Limits
  /** The manager's reconcile: networks first, then the transfer's own. */
  reconcile(): void
  failDownload(message: string, discard?: boolean): void
  failNetwork(network: DownloadNetwork, message: string): void
  scheduleUpdate(): void
}

// Raw per-event deltas are too noisy to display (socket buffers flush in
// irregular bursts a few ms apart). Averaging over a few seconds instead
// gives a speed/ETA reading that tracks reality without jumping around.
const SPEED_WINDOW_MS = 3000

/**
 * Bytes counted as they arrive, and read as a rate only on the download's clock (its tick).
 * Arrivals come in bursts — socket flushes, and a speed limit pausing reads between them — so a
 * window that starts or ends on one is off by up to a burst: sampled on arrival, a 7 MB/s limit
 * read 6.9. Between two clock readings, where the bursts fall doesn't matter.
 */
export class Meter {
  private total = 0
  private readings: { bytes: number; time: number }[] = []

  add(bytes: number): void {
    this.total += bytes
  }

  /** The rate over the last SPEED_WINDOW_MS, as of `now`. Bytes before the first reading are
   * the meter's starting point, not part of any rate. */
  read(now: number): number {
    const { readings } = this
    readings.push({ bytes: this.total, time: now })
    while (readings.length > 2 && readings[1].time <= now - SPEED_WINDOW_MS) readings.shift()
    const oldest = readings[0]
    // At least a second: the clock can come round again ms later (a stream ending wakes it), and
    // one burst over a few ms reads as a speed the connection never had (and sticks as the peak).
    return (this.total - oldest.bytes) / Math.max((now - oldest.time) / 1000, 1)
  }
}

/** A download's meters in one direction: each connection's, and each network's. A network's is
 * its own rather than its connections' added up, so its bytes stay counted when one ends. */
export class Meters {
  readonly connections = new Map<number, Meter>()
  readonly networks = new Map<string, Meter>()

  /** Counts `bytes` through connection `connectionId`, on network `networkId`. */
  add(connectionId: number, networkId: string, bytes: number): void {
    meterOf(this.connections, connectionId).add(bytes)
    meterOf(this.networks, networkId).add(bytes)
  }

  clear(): void {
    this.connections.clear()
    this.networks.clear()
  }
}

function meterOf<K>(meters: Map<K, Meter>, key: K): Meter {
  let meter = meters.get(key)
  if (!meter) meters.set(key, (meter = new Meter()))
  return meter
}

/** Reads every meter as of `now` into the download's speeds: each connection's, each
 * network's and the download's, uploads too for a torrent. Says whether any of them changed. */
export function updateSpeeds(runtime: TransferTarget, now: number): boolean {
  const { state } = runtime
  let changed = false
  const set = <T, K extends keyof T>(target: T, key: K, value: T[K]): void => {
    if (target[key] !== value) changed = true
    target[key] = value
  }
  const connections: Array<{ id: number; status: string; speedBytesPerSec: number }> =
    state.kind === 'http' ? state.streams : state.peers
  for (const connection of connections) {
    // Read every tick, moving or not, so its window is never stale when it moves again.
    const speed = runtime.meters.connections.get(connection.id)?.read(now) ?? 0
    // Between blocks, waiting to retry, or a peer sending nothing: 0, not what it last did.
    const moving = connection.status === 'downloading' || connection.status === 'receiving'
    set(connection, 'speedBytesPerSec', moving ? speed : 0)
  }
  let total = 0
  for (const network of state.networks) {
    const speed = runtime.meters.networks.get(network.id)?.read(now) ?? 0
    set(network, 'speedBytesPerSec', speed)
    total += speed
  }
  set(state, 'speedBytesPerSec', total)

  if ('uploadMeters' in runtime) {
    const { uploadMeters, state } = runtime
    for (const peer of state.peers) {
      set(peer, 'uploadSpeedBytesPerSec', uploadMeters.connections.get(peer.id)?.read(now) ?? 0)
    }
    let uploaded = 0
    for (const network of state.networks) {
      const speed = uploadMeters.networks.get(network.id)?.read(now) ?? 0
      set(network, 'uploadSpeedBytesPerSec', speed)
      uploaded += speed
    }
    set(state, 'uploadSpeedBytesPerSec', uploaded)
  }
  return changed
}

/** Nothing is moving: a paused or stopped download reads 0 everywhere. */
export function clearSpeeds(state: DownloadState): void {
  state.speedBytesPerSec = 0
  const connections = state.kind === 'http' ? state.streams : state.peers
  for (const connection of connections) connection.speedBytesPerSec = 0
  for (const network of state.networks) network.speedBytesPerSec = 0
  if (state.kind === 'torrent') {
    state.uploadSpeedBytesPerSec = 0
    for (const network of state.networks) network.uploadSpeedBytesPerSec = 0
    for (const peer of state.peers) peer.uploadSpeedBytesPerSec = 0
  }
}

/** Waits, but returns early if the signal aborts (pause/cancel shouldn't wait out a retry backoff). */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
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

/** Re-derives verified byte counts from HTTP blocks or torrent pieces. */
export function recomputeAggregates(
  state: DownloadState,
  units: readonly DownloadUnitState[]
): void {
  let total = 0
  const byNetwork = new Map<string, number>()
  for (const block of units) {
    total += block.bytesDownloaded
    for (const [id, bytes] of Object.entries(block.bytesByInterface)) {
      byNetwork.set(id, (byNetwork.get(id) ?? 0) + bytes)
    }
  }
  state.bytesDownloaded = total
  for (const network of state.networks) {
    network.bytesDownloaded = byNetwork.get(network.id) ?? 0
  }
}
