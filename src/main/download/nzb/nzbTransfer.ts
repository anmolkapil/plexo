import type {
  DownloadStatus,
  HttpDownloadNetwork,
  HttpStreamState,
  NzbSegmentState
} from '../../../shared/types'
import { testKnobs } from '../../testKnobs'
import {
  asConnectionError,
  ConnectionError,
  connectThrough,
  NoCompatibleRouteError
} from '../../network/routes'
import { advanceBlock, retractBlock } from '../blockProgress'
import { interleave } from '../plan'
import {
  delay,
  recomputeAggregates,
  type NzbTransferTarget,
  type Transfer,
  type TransferHost
} from '../transfer'
import { ArticleMissingError, NntpAuthError, NntpConnection, NntpRefusedError } from './nntp'
import type { NzbSegment } from './nzbFile'
import { USENET_OFF, type UsenetServerConfig } from './usenetServer'
import { decodeYenc, YencError } from './yenc'

// Set PLEXO_DEBUG=1 to log every article's outcome.
const debug: (...args: unknown[]) => void = process.env['PLEXO_DEBUG']
  ? (...args) => console.debug('[plexo nzb]', ...args)
  : () => {}

const RETRY_BASE_DELAY_MS = testKnobs.retryBaseDelayMs
const RETRY_MAX_DELAY_MS = 15_000
const UNREACHABLE_RETRY_MS = 5_000
const SILENT_AFTER_MS = testKnobs.silentAfterMs
/** How often a connection with nothing to do looks for an article again. */
const IDLE_POLL_MS = 250
/** Answers that make no sense from a working server, in a row, before a connection gives up. */
const MAX_STRIKES = 5
/** A damaged article is fetched this many times before it counts as missing: a server sends the
 * same copy each time, but a connection can garble one in passing. */
const DAMAGED_TRIES = 2

/** Doubling, with ±20% jitter, as HTTP streams back off (see httpTransfer.ts). */
function retryDelayMs(attempt: number): number {
  const exact = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
  return exact * (0.8 + 0.4 * Math.random())
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** One article to fetch: its segment, where its data goes, and the NZB's record of it. */
export interface Article {
  /** The file it is part of, by index into the download's files. */
  file: number
  segment: NzbSegment
}

interface Connection {
  /** Stops the connection for good: a pause, a cancel, retiring it. */
  controller: AbortController
  /** Cuts its waits short: when it stops, or the run ends. */
  wait: AbortSignal
  /** Cuts a backoff short without stopping it (see wake). Replaced once used. */
  nudge: AbortController
  /** Its session with the server, signed in; null until it opens one, and after one fails. */
  session: NntpConnection | null
  /** What it is fetching: aborted to drop the socket under it (see wake). */
  fetching: AbortController | null
  failures: number
  strikes: number
  retiring: boolean
  /** To the backup server, for the articles the main one doesn't have. */
  backup: boolean
}

/**
 * Fetches an NZB's articles over connections to the user's news server, each one through one
 * network, as HTTP streams are. A connection signs in once and then takes article after article
 * — the lowest-numbered one no other connection holds — decodes it (yEnc) and writes it straight
 * into its file at the offset the article itself gives (see NzbDestination).
 *
 * The server allows its account only so many connections at once, for every network together:
 * they are shared out evenly over the networks in use. A server that turns one away (too many)
 * gets one fewer for the rest of the run.
 *
 * An article counts once it is decoded, checked (CRC-32) and written. One the server doesn't have,
 * or keeps sending damaged, goes to the backup server when one is set up: it has its own
 * connections, opened only once there's an article for it. One neither server has is marked
 * missing and the download carries on: a par2 repair restores it, which Plexo leaves to the
 * user's tools.
 */
export class NzbTransfer implements Transfer {
  private connections = new Map<number, Connection>()
  /** The running connections' workers, by stream id. */
  private workers = new Map<number, Promise<void>>()
  /** The server, as loaded for this run; null until it has been. */
  private server: UsenetServerConfig | null = null
  private loading: Promise<void> | null = null
  /** Connections the server lets this run keep: its setting, less what it turned away. */
  private allowed = Infinity
  /** The backup server's connections, kept apart from the download's streams (the main
   * server's), and what it lets this run keep. */
  private backupStreams: HttpStreamState[] = []
  private backupAllowed = Infinity
  /** Articles the main server doesn't have, for the backup server: by segment index. */
  private forBackup = new Set<number>()
  /** Since when the backup server's connections have failed without a byte in between. */
  private backupFailingSince: number | null = null
  /** The backup server is out of this run (see backupFailed). */
  private backupDown = false
  /** Articles in flight, by segment index. */
  private inFlight = new Set<number>()
  /** Damaged copies received, by segment index. */
  private damaged = new Map<number, number>()
  /** By network: when it last showed it can reach the server. */
  private aliveAt = new Map<string, number>()

  constructor(
    private readonly runtime: NzbTransferTarget,
    private readonly host: TransferHost,
    /** By segment index. */
    private readonly articles: readonly Article[],
    private readonly loadServer: () => Promise<UsenetServerConfig | null>
  ) {}

  reconcile(): void {
    if (!this.server) {
      this.loading ??= this.loadServer().then(
        (server) => {
          if (this.runtime.stop.signal.aborted) return
          if (!server) {
            this.host.failDownload('Set up a news server in Plexo to download from Usenet.')
            return
          }
          if (!server.enabled) {
            this.host.failDownload(USENET_OFF)
            return
          }
          this.server = server
          this.allowed = server.connections
          this.backupAllowed = server.backup?.connections ?? 0
          // The last run's word on the backup server: this run asks it again.
          this.runtime.state.backupError = undefined
          // What neither server had last time is asked for again: the backup's settings may have
          // been put right since (a password), and the servers may have the articles by now.
          if (server.backup) this.retryMissing()
          this.host.reconcile()
        },
        (error) => this.host.failDownload(message(error))
      )
      return
    }
    const { state } = this.runtime
    const usable = state.networks.filter(
      (network) => network.status === 'on' || network.status === 'unreachable'
    )
    // New connections only for articles no connection is on yet: near the end, fewer are needed.
    const waiting = (backup: boolean): number =>
      this.runtime.blocks.filter(
        (block) =>
          block.status === 'pending' &&
          !this.inFlight.has(block.index) &&
          this.forBackup.has(block.index) === backup
      ).length
    if (this.backupDown) {
      // What waits for the backup server now has nowhere to come from.
      for (const index of this.forBackup) {
        if (!this.inFlight.has(index)) this.markMissing(this.runtime.blocks[index])
      }
    }
    const backup = this.server.backup && !this.backupDown
    // Out of reach for a while: it keeps one connection trying, as the main server does.
    const backupTotal = this.backupUnreachable() ? 1 : this.backupAllowed
    const toStart = [
      ...this.plan(false, shareConnections(usable, this.allowed), waiting(false)),
      // Without articles for it, none: retiring any it has.
      ...this.plan(
        true,
        backup ? shareConnections(usable, backupTotal) : new Map(),
        backup ? waiting(true) : 0
      )
    ]
    // Every network gets its first connection before any gets a second.
    this.start(interleave(toStart, (stream) => stream.interfaceId))
  }

  /** Articles marked missing, pending again. */
  private retryMissing(): void {
    const { state } = this.runtime
    for (const block of this.runtime.blocks) {
      if (block.status !== 'missing') continue
      block.status = 'pending'
      state.nzbFiles[this.articles[block.index].file].missing -= 1
      state.missingBytes -= block.rangeEnd! - block.rangeStart + 1
    }
  }

  private backupUnreachable(): boolean {
    return (
      this.backupFailingSince !== null && Date.now() - this.backupFailingSince >= SILENT_AFTER_MS
    )
  }

  /** The backup server answered: reachable, whatever it said. */
  private backupAnswered(): void {
    this.backupFailingSince = null
    if (!this.backupDown) this.runtime.state.backupError = undefined
  }

  /** Which of one server's connections to start, stop or open, network by network: `targets`
   * of them, for `waiting` articles. */
  private plan(backup: boolean, targets: Map<string, number>, waiting: number): HttpStreamState[] {
    const now = Date.now()
    const toStart: HttpStreamState[] = []
    for (const network of this.runtime.state.networks) {
      // Idle ones first, so retiring one doesn't cut an article short.
      const live = this.liveStreams(network.id, backup).sort(
        (a, b) =>
          Number(a.currentBlockIndex === undefined) - Number(b.currentBlockIndex === undefined)
      )
      const target = targets.get(network.id) ?? 0
      if (!backup && target > 0 && !this.aliveAt.has(network.id)) this.aliveAt.set(network.id, now)
      if (live.length > target) this.retire(live.slice(target))
      // Kept from before a pause: started again while there is work for them, dropped if not.
      for (const stream of live.slice(0, target)) {
        if (this.workers.has(stream.id)) continue
        if (waiting > 0) {
          toStart.push(stream)
          waiting--
        } else {
          this.removeStream(stream)
        }
      }
      const adding = Math.min(target - Math.min(live.length, target), waiting)
      if (adding > 0) {
        toStart.push(...this.addStreams(network.id, adding, backup))
        waiting -= adding
      }
    }
    return toStart
  }

  tick(): void {
    this.host.reconcile()
  }

  running(): Iterable<Promise<void>> {
    return this.workers.values()
  }

  abort(): void {
    for (const connection of this.connections.values()) connection.controller.abort()
  }

  reset(): void {
    this.server = null
    this.loading = null
    this.allowed = Infinity
    this.damaged.clear()
    this.aliveAt.clear()
    // Those that were waiting for it are the main server's again: it may have them by now.
    this.forBackup.clear()
    this.backupFailingSince = null
    this.backupDown = false
  }

  wake(pick: (networkId: string) => boolean, reconnect: (networkId: string) => boolean): void {
    for (const stream of [...this.runtime.state.streams, ...this.backupStreams]) {
      const connection = this.connections.get(stream.id)
      if (!connection || connection.retiring || !pick(stream.interfaceId)) continue
      connection.failures = 0
      if (reconnect(stream.interfaceId)) {
        connection.fetching?.abort()
        connection.session?.destroy()
        connection.session = null
      }
      connection.nudge.abort()
    }
  }

  systemResumed(now: number): void {
    for (const id of this.aliveAt.keys()) this.aliveAt.set(id, now)
    // Its failures from before the sleep say nothing about it now.
    this.backupFailingSince = null
    this.wake(
      () => true,
      () => true
    )
  }

  private network(id: string): HttpDownloadNetwork {
    const network = this.runtime.state.networks.find((entry) => entry.id === id)
    if (!network) throw new Error(`Unknown network ${id}`)
    return network
  }

  private liveStreams(networkId: string, backup = false): HttpStreamState[] {
    return (backup ? this.backupStreams : this.runtime.state.streams).filter(
      (stream) => stream.interfaceId === networkId && !this.connections.get(stream.id)?.retiring
    )
  }

  private addStreams(networkId: string, count: number, backup: boolean): HttpStreamState[] {
    const { state } = this.runtime
    // The backup server's count down from -1: never one of the main server's ids.
    let id = backup
      ? Math.min(0, ...this.backupStreams.map((stream) => stream.id))
      : Math.max(-1, ...state.streams.map((stream) => stream.id))
    const added = Array.from({ length: count }, (): HttpStreamState => ({
      id: backup ? --id : ++id,
      interfaceId: networkId,
      rangeStart: 0,
      rangeEnd: null,
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'pending'
    }))
    if (backup) {
      this.backupStreams.push(...added)
    } else {
      state.streams.push(...added)
      state.peakStreams = Math.max(state.peakStreams, state.streams.length)
    }
    this.host.scheduleUpdate()
    return added
  }

  /** Stops these streams for good; what one was fetching goes back for another to take. */
  private retire(streams: HttpStreamState[]): void {
    for (const stream of streams) {
      const connection = this.connections.get(stream.id)
      if (connection && this.workers.has(stream.id)) {
        connection.retiring = true
        connection.controller.abort()
      } else {
        this.removeStream(stream)
      }
    }
  }

  private removeStream(stream: HttpStreamState): void {
    this.connections.delete(stream.id)
    this.runtime.meters.connections.delete(stream.id)
    for (const streams of [this.runtime.state.streams, this.backupStreams]) {
      const index = streams.indexOf(stream)
      if (index >= 0) streams.splice(index, 1)
    }
    this.host.scheduleUpdate()
  }

  private start(streams: HttpStreamState[]): void {
    for (const stream of streams) {
      this.workers.set(
        stream.id,
        this.runConnection(stream).finally(() => {
          this.workers.delete(stream.id)
          if (this.connections.get(stream.id)?.retiring) this.removeStream(stream)
        })
      )
    }
    if (streams.length > 0) this.host.scheduleUpdate()
  }

  /** The lowest-numbered article nothing holds, taken: of those for the backup server, or of the
   * rest. */
  private claim(backup: boolean): NzbSegmentState | null {
    for (const block of this.runtime.blocks) {
      if (
        block.status === 'pending' &&
        !this.inFlight.has(block.index) &&
        this.forBackup.has(block.index) === backup
      ) {
        this.inFlight.add(block.index)
        return block
      }
    }
    return null
  }

  private goIdle(stream: HttpStreamState): void {
    stream.status = 'pending'
    stream.currentBlockIndex = undefined
    stream.speedBytesPerSec = 0
  }

  /** The article goes back, unfinished, for any connection to take. */
  private release(stream: HttpStreamState, block: NzbSegmentState): void {
    this.inFlight.delete(block.index)
    if (block.status === 'downloading') block.status = 'pending'
    if (retractBlock(block, 0, stream.interfaceId) > 0) {
      recomputeAggregates(this.runtime.state, this.runtime.blocks)
    }
    this.goIdle(stream)
    this.host.scheduleUpdate()
  }

  private stopped(connection: Connection): boolean {
    return (
      connection.controller.signal.aborted ||
      connection.retiring ||
      (this.runtime.state.status as DownloadStatus) !== 'downloading'
    )
  }

  private async runConnection(stream: HttpStreamState): Promise<void> {
    const controller = new AbortController()
    const connection: Connection = {
      controller,
      wait: AbortSignal.any([controller.signal, this.runtime.stop.signal]),
      nudge: new AbortController(),
      session: null,
      fetching: null,
      failures: 0,
      strikes: 0,
      retiring: false,
      backup: this.backupStreams.includes(stream)
    }
    this.connections.set(stream.id, connection)
    try {
      while (!this.stopped(connection)) {
        const block = this.claim(connection.backup)
        if (!block) {
          this.goIdle(stream)
          // Others still have articles in flight: one may come back for this connection to take.
          // A backup server connection doesn't wait for that: it is opened again once there is
          // an article for it (see reconcile), rather than held open for the whole download.
          if (this.inFlight.size > 0 && !connection.backup) {
            await delay(IDLE_POLL_MS, connection.wait)
            continue
          }
          stream.status = 'completed'
          this.host.scheduleUpdate()
          break
        }
        const next = await this.fetch(stream, connection, block)
        if (next === 'stop') break
      }
    } finally {
      connection.session?.close()
      connection.session = null
      if (stream.status !== 'completed') {
        stream.status = this.runtime.state.status === 'paused' ? 'paused' : 'cancelled'
      }
      stream.currentBlockIndex = undefined
      stream.speedBytesPerSec = 0
      this.host.scheduleUpdate()
    }
  }

  /** Fetches, decodes and writes one article, and applies what became of it. */
  private async fetch(
    stream: HttpStreamState,
    connection: Connection,
    block: NzbSegmentState
  ): Promise<'continue' | 'stop'> {
    const { segment, file } = this.articles[block.index]
    const networkId = stream.interfaceId
    block.status = 'downloading'
    block.interfaceId = networkId
    stream.status = 'downloading'
    stream.currentBlockIndex = block.index
    stream.rangeStart = block.rangeStart
    stream.rangeEnd = block.rangeEnd
    this.host.scheduleUpdate()

    const fetching = new AbortController()
    connection.fetching = fetching
    const signal = AbortSignal.any([connection.controller.signal, fetching.signal])
    const length = block.rangeEnd! - block.rangeStart + 1
    let received = 0
    try {
      connection.session ??= await this.openSession(networkId, signal, connection.backup)
      const body = await connection.session.body(
        segment.messageId,
        (bytes) => {
          received += bytes
          this.onReceived(stream, block, Math.min(received, length - 1), bytes)
          return this.host.limits.take(networkId, bytes)
        },
        signal
      )
      const part = decodeYenc(body)
      await this.runtime.file.write(file, part.offset, part.data)
      const entry = this.runtime.state.nzbFiles[file]
      entry.size ??= part.fileSize
      this.complete(stream, block)
      if (connection.backup) {
        this.runtime.state.fromBackup = (this.runtime.state.fromBackup ?? 0) + 1
      }
      connection.failures = 0
      connection.strikes = 0
      debug('article', { segment: block.index, network: networkId, bytes: received })
      return 'continue'
    } catch (error) {
      if (fetching.signal.aborted && !this.stopped(connection)) {
        // Dropped on purpose (see wake): not a failure, and the article is taken up again at once.
        this.release(stream, block)
        connection.session?.destroy()
        connection.session = null
        return 'continue'
      }
      return this.failed(stream, connection, block, error)
    } finally {
      connection.fetching = null
    }
  }

  private async openSession(
    networkId: string,
    signal: AbortSignal,
    backup: boolean
  ): Promise<NntpConnection> {
    const server = backup ? this.server!.backup! : this.server!
    const iface = this.host.networks.find(networkId)
    if (!iface) throw new ConnectionError(new Error('The network is not connected'))
    // Refused, timed out, or a failed TLS handshake: the server can't be reached, as with a
    // dropped connection (see failed), rather than a strike against the server.
    const socket = await connectThrough(
      iface,
      server.host,
      server.port,
      server.tls,
      Math.min(testKnobs.connectTimeoutMs, testKnobs.stallTimeoutMs),
      signal,
      this.host.getProxyForInterface?.(networkId)
    ).catch((error: unknown) => {
      throw asConnectionError(error)
    })
    return NntpConnection.open(socket, {
      timeoutMs: testKnobs.stallTimeoutMs,
      username: server.username,
      password: server.password,
      signal
    })
  }

  /** Bytes of an article came in: it moves on screen, and the network is through. */
  private onReceived(
    stream: HttpStreamState,
    block: NzbSegmentState,
    position: number,
    bytes: number
  ): void {
    const networkId = stream.interfaceId
    const network = this.network(networkId)
    // The backup server getting through says nothing of the main one (see failed).
    if (this.connections.get(stream.id)?.backup) {
      this.backupAnswered()
    } else {
      this.aliveAt.set(networkId, Date.now())
      if (network.status === 'unreachable') network.status = 'on'
    }
    // Shown as it comes, short of its last byte: the article counts once it's written.
    const gained = advanceBlock(block, networkId, position)
    stream.bytesDownloaded += gained
    network.bytesDownloaded += gained
    this.runtime.state.bytesDownloaded += gained
    this.runtime.meters.add(stream.id, networkId, bytes)
    this.host.scheduleUpdate()
  }

  private complete(stream: HttpStreamState, block: NzbSegmentState): void {
    this.inFlight.delete(block.index)
    this.damaged.delete(block.index)
    this.forBackup.delete(block.index)
    const gained = advanceBlock(block, stream.interfaceId, block.rangeEnd! - block.rangeStart + 1)
    stream.bytesDownloaded += gained
    block.status = 'completed'
    recomputeAggregates(this.runtime.state, this.runtime.blocks)
    // Between articles, not idle: it keeps its speed, which only the download's clock reads (an
    // article takes about as long as one tick, so zeroing it here showed every connection at 0).
    stream.status = 'pending'
    stream.currentBlockIndex = undefined
    this.host.scheduleUpdate()
  }

  /** The server doesn't have the article, or keeps sending it damaged: the backup server's to
   * try, when there's one to, or missing. */
  private notOnServer(
    stream: HttpStreamState,
    connection: Connection,
    block: NzbSegmentState
  ): void {
    this.release(stream, block)
    this.damaged.delete(block.index)
    if (connection.backup) this.backupAnswered()
    if (connection.backup || !this.server?.backup || this.backupDown) {
      this.markMissing(block)
      return
    }
    // Its connections open on the next tick (see reconcile).
    this.forBackup.add(block.index)
  }

  /** The article is gone from the servers, or keeps coming damaged: left as zeros, for a par2
   * repair. Every article missing means the servers have none of this NZB, which is no download. */
  private markMissing(block: NzbSegmentState): void {
    this.forBackup.delete(block.index)
    block.status = 'missing'
    const { state } = this.runtime
    state.nzbFiles[this.articles[block.index].file].missing += 1
    state.missingBytes += block.rangeEnd! - block.rangeStart + 1
    this.host.scheduleUpdate()
    if (this.runtime.blocks.every((other) => other.status === 'missing')) {
      this.host.failDownload(
        'The news server has none of this NZB’s articles. They may have expired, or been taken down.',
        true
      )
    }
  }

  private async failed(
    stream: HttpStreamState,
    connection: Connection,
    block: NzbSegmentState,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    debug('article failed', {
      segment: block.index,
      network: stream.interfaceId,
      error: message(error)
    })
    if (this.stopped(connection)) {
      this.release(stream, block)
      return 'stop'
    }
    if (error instanceof ArticleMissingError) {
      this.notOnServer(stream, connection, block)
      return 'continue'
    }
    if (error instanceof YencError) {
      const tries = (this.damaged.get(block.index) ?? 0) + 1
      this.damaged.set(block.index, tries)
      if (tries >= DAMAGED_TRIES) this.notOnServer(stream, connection, block)
      else this.release(stream, block)
      return 'continue'
    }
    this.release(stream, block)
    // The session can't be trusted after anything else: a fresh one next time.
    connection.session?.destroy()
    connection.session = null
    if (connection.backup) return this.backupFailed(stream, connection, error)
    const network = this.network(stream.interfaceId)

    if (error instanceof NntpAuthError) {
      this.host.failDownload(
        `The news server didn’t accept the username or password. Check them in the server’s settings, then try again. (${error.message})`
      )
      return 'stop'
    }
    if (error instanceof NoCompatibleRouteError) {
      this.host.failNetwork(network, error.message)
      return 'stop'
    }
    if (error instanceof NntpRefusedError) {
      // Over the account's limit: one connection fewer from now on. The last one keeps trying.
      const live = this.runtime.state.streams.filter(
        (other) => !this.connections.get(other.id)?.retiring
      ).length
      if (live > 1) {
        this.allowed = Math.min(this.allowed, live - 1)
        connection.retiring = true
        this.host.reconcile()
        return 'stop'
      }
    }

    const now = Date.now()
    if (
      error instanceof ConnectionError &&
      network.status === 'on' &&
      now - (this.aliveAt.get(network.id) ?? now) >= SILENT_AFTER_MS
    ) {
      // Nothing through this network for a while, and its connections failing: it can't reach
      // the server. It keeps one connection trying (see reconcile).
      network.status = 'unreachable'
      this.host.reconcile()
    }
    if (!(error instanceof ConnectionError) && !(error instanceof NntpRefusedError)) {
      if (++connection.strikes > MAX_STRIKES) {
        connection.retiring = true
        if (this.liveStreams(network.id).length === 0)
          this.host.failNetwork(network, message(error))
        return 'stop'
      }
    }
    if (network.status === 'on') network.retries += 1
    connection.failures += 1
    let wait = retryDelayMs(connection.failures)
    if (network.status === 'unreachable') wait = Math.min(wait, UNREACHABLE_RETRY_MS)
    stream.status = 'retrying'
    this.host.scheduleUpdate()
    await delay(wait, AbortSignal.any([connection.wait, connection.nudge.signal]))
    if (connection.nudge.signal.aborted) connection.nudge = new AbortController()
    if (this.stopped(connection)) return 'stop'
    this.goIdle(stream)
    return 'continue'
  }

  /**
   * A backup server connection failed. The backup server turning the sign-in down, having no
   * route from the network, or answering what makes no sense time after time is out of this run:
   * what it would have sent counts as missing (asked for again on a resume, see reconcile), and
   * the download carries on without it. Anything else it is tried again, as the main server is:
   * failing for SILENT_AFTER_MS, it can't be reached and keeps one connection trying. One fewer
   * when it turned one away for the account's limit.
   */
  private async backupFailed(
    stream: HttpStreamState,
    connection: Connection,
    error: unknown
  ): Promise<'continue' | 'stop'> {
    this.backupFailingSince ??= Date.now()
    if (error instanceof NntpRefusedError) {
      // Over the account's limit, as for the main server (see failed).
      const live = this.backupStreams.filter(
        (other) => !this.connections.get(other.id)?.retiring
      ).length
      if (live > 1) {
        this.backupAllowed = Math.min(this.backupAllowed, live - 1)
        connection.retiring = true
        this.host.reconcile()
        return 'stop'
      }
    } else if (!(error instanceof ConnectionError)) {
      connection.strikes += 1
    }
    if (
      error instanceof NntpAuthError ||
      error instanceof NoCompatibleRouteError ||
      connection.strikes > MAX_STRIKES
    ) {
      this.backupDown = true
      this.runtime.state.backupError =
        error instanceof NntpAuthError
          ? `The backup server didn’t accept the username or password. (${error.message})`
          : `The backup server couldn’t be used. (${message(error)})`
      this.host.reconcile()
      return 'stop'
    }
    const unreachable = this.backupUnreachable()
    if (unreachable) {
      this.runtime.state.backupError = `The backup server can’t be reached. Plexo keeps trying. (${message(error)})`
      // Down to one connection.
      this.host.reconcile()
    }
    connection.failures += 1
    let wait = retryDelayMs(connection.failures)
    if (unreachable) wait = Math.min(wait, UNREACHABLE_RETRY_MS)
    stream.status = 'retrying'
    this.host.scheduleUpdate()
    await delay(wait, AbortSignal.any([connection.wait, connection.nudge.signal]))
    if (connection.nudge.signal.aborted) connection.nudge = new AbortController()
    if (this.stopped(connection)) return 'stop'
    this.goIdle(stream)
    return 'continue'
  }
}

/** `total` connections over `networks`: one for each that can't reach the server (it only
 * keeps trying), the rest evenly over those in use, the first ones taking what doesn't divide. */
export function shareConnections(
  networks: readonly HttpDownloadNetwork[],
  total: number
): Map<string, number> {
  const shares = new Map<string, number>()
  const trying = networks.filter((network) => network.status === 'unreachable')
  const inUse = networks.filter((network) => network.status === 'on')
  let left = total
  for (const network of trying) {
    if (left <= 0) break
    shares.set(network.id, 1)
    left--
  }
  inUse.forEach((network, index) => {
    const share = Math.floor(left / inUse.length) + (index < left % inUse.length ? 1 : 0)
    shares.set(network.id, share)
  })
  // Fewer connections than networks: the one that can't reach the server gives way first.
  if (inUse.length > 0 && inUse.every((network) => shares.get(network.id) === 0)) {
    shares.set(inUse[0].id, 1)
    const given = trying.find((network) => shares.get(network.id))
    if (given) shares.set(given.id, 0)
  }
  return shares
}
