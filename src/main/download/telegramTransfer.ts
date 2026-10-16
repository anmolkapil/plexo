import type {
  DownloadStatus,
  HttpBlockState,
  StartTelegramDownloadRequest,
  TelegramDownloadNetwork,
  TelegramReaderState
} from '../../shared/types'
import { describeError } from '../../shared/errors'
import { advanceBlock } from './blockProgress'
import {
  delay,
  recomputeAggregates,
  type Transfer,
  type TransferHost,
  type TelegramTransferTarget
} from './transfer'

/**
 * Where a Telegram file's bytes come from: the telegram module's client, speaking MTProto. One
 * request asks for up to 1 MiB at a 4096-aligned offset — upload.GetFile's own shape — and an
 * empty answer means the end of the file (only a photo's download runs to one: Telegram doesn't
 * say a photo's size ahead of time).
 */
export interface TelegramFileSource {
  /** True when the size is unknown (a photo): requests run until an empty answer. */
  unknownSize: boolean
  request(offset: number, limit: number, signal: AbortSignal): Promise<Buffer>
  /** Closes the connections this source opened. Best-effort; safe to repeat. */
  dispose(): Promise<void>
}

/** Why a request failed, as the transfer acts on it. */
export type TelegramFileErrorKind = 'rate' | 'network' | 'auth' | 'missing' | 'other'

export class TelegramFileError extends Error {
  constructor(
    readonly kind: TelegramFileErrorKind,
    message: string,
    /** For 'rate': how long Telegram asked to be left alone, in seconds. */
    readonly waitSeconds?: number
  ) {
    super(message)
  }
}

/** upload.GetFile answers at most 1 MiB, at offsets and limits divisible by 4096. */
export const FILE_CHUNK_BYTES = 1024 * 1024
/** Readers, each holding one dedicated connection to Telegram's DC under the same login —
 * the shape of a fast download in Telegram's own desktop client. */
export const READER_POOL = 8
const MAX_RETRIES = 8
const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 15_000
/** A rate-limit wait longer than this ends the download (resumable) rather than holding it. */
const RATE_WAIT_MAX_MS = 120_000

interface ReaderRuntime {
  id: number
  controller: AbortController
  /** Cuts its waits short when the run stops. */
  wait: AbortSignal
  failures: number
}

type BlockOutcome =
  | { type: 'completed' }
  | { type: 'stopped' }
  | { type: 'retry'; waitMs: number }
  | { type: 'give-up'; error: unknown }

/** A chunk request already in flight, settled with an Error rather than rejecting, so a
 * prefetch outliving its reader can never be an unhandled rejection. */
interface Prefetch {
  block: HttpBlockState
  /** The file offset this request asks for. */
  offset: number
  promise: Promise<Buffer | Error>
}

/**
 * Fetches a Telegram file: a pool of readers, each on its own connection to the file's data
 * center, claiming pending blocks and keeping its connection full — the next chunk request
 * goes out before the current one is written. Chunks land at their own offsets in the staging
 * file, the same shape the HTTP transfer writes, so pause/resume, progress and the block grid
 * all work unchanged. Telegram is reached however the OS routes, so a reader's bytes are
 * attributed to whichever network was first-enabled when it claimed its block.
 */
export class TelegramTransfer implements Transfer {
  private workers = new Map<number, Promise<void>>()
  private readers = new Map<number, ReaderRuntime>()
  private readerIds = 0
  private stopped = false
  /** The file source (a promise: it may need a round trip to Telegram to find the file). */
  private sourcePromise: Promise<TelegramFileSource> | undefined
  /** Until when Telegram asked every connection to slow down (see asOutcome). */
  private rateLimitedUntil = 0

  constructor(
    private readonly runtime: TelegramTransferTarget,
    private readonly host: TransferHost,
    private readonly makeSource: () => Promise<TelegramFileSource> | TelegramFileSource
  ) {}

  private source(): Promise<TelegramFileSource> {
    this.sourcePromise ??= Promise.resolve(this.makeSource())
    return this.sourcePromise
  }

  /** Closes the source's connections and forgets it, so the next run builds a fresh one
   * (whose message lookup also refreshes a stale file reference). */
  private async disposeSource(): Promise<void> {
    const promise = this.sourcePromise
    this.sourcePromise = undefined
    if (!promise) return
    try {
      const source = await promise
      await source.dispose()
    } catch {
      // Best-effort: the source may itself have failed to open.
    }
  }

  reconcile(): void {
    if (this.stopped) return
    const { state } = this.runtime
    // A photo's size is unknown, so its one block runs sequentially; everything else splits
    // across the pool.
    const desired = photoDownload(this.runtime.requestPayload)
      ? 1
      : Math.max(
          1,
          Math.min(READER_POOL, state.blocks.filter((block) => block.status !== 'completed').length)
        )
    while (this.workers.size < desired && this.readers.size < desired) {
      this.addReader()
    }
  }

  tick(): void {
    // The manager's reconcile runs from here each tick as it does for HTTP, so a network
    // turned off, a limit reached or a schedule window closing is noticed mid-run.
    this.host.reconcile()
  }

  running(): Iterable<Promise<void>> {
    return this.workers.values()
  }

  abort(): void {
    this.stopped = true
    for (const reader of this.readers.values()) reader.controller.abort()
    void this.disposeSource()
  }

  reset(): void {
    // A new run starts its pool over: fresh connections and a fresh message lookup; blocks
    // keep what they have on disk.
    for (const reader of this.readers.values()) reader.controller.abort()
    this.readers.clear()
    this.workers.clear()
    this.stopped = false
    this.rateLimitedUntil = 0
    void this.disposeSource()
  }

  wake(): void {
    // Nothing of this transfer's waits on a backoff that a network change should cut short:
    // the readers retry on their own.
  }

  systemResumed(): void {
    // The sockets under the session are likely dead, though nothing says so until a request
    // fails; dropping the in-flight ones makes that happen now rather than after a stall.
    for (const reader of this.readers.values()) reader.controller.abort()
    this.readers.clear()
    this.workers.clear()
    this.stopped = false
    void this.disposeSource()
  }

  private addReader(): void {
    const { state } = this.runtime
    const controller = new AbortController()
    const reader: TelegramReaderState = {
      id: ++this.readerIds,
      interfaceId: state.networks.find((network) => network.enabled)?.id ?? '',
      bytesDownloaded: 0,
      speedBytesPerSec: 0,
      status: 'pending'
    }
    state.readers.push(reader)
    state.peakReaders = Math.max(state.peakReaders, state.readers.length)
    const self: ReaderRuntime = {
      id: reader.id,
      controller,
      wait: AbortSignal.any([controller.signal, this.runtime.stop.signal]),
      failures: 0
    }
    this.readers.set(reader.id, self)
    this.workers.set(
      reader.id,
      this.runReader(reader, self).finally(() => {
        this.workers.delete(reader.id)
        this.readers.delete(reader.id)
        const index = state.readers.indexOf(reader)
        if (index >= 0) state.readers.splice(index, 1)
        if (this.workers.size === 0) void this.disposeSource()
        this.host.scheduleUpdate()
      })
    )
  }

  private networkOf(reader: TelegramReaderState): TelegramDownloadNetwork | undefined {
    const { state } = this.runtime
    const network =
      state.networks.find((entry) => entry.id === reader.interfaceId && entry.enabled) ??
      state.networks.find((entry) => entry.enabled)
    return network
  }

  /** Claims the first pending block for `reader`, synchronously — no other reader can take
   * it between the find and here. */
  private claimBlock(reader: TelegramReaderState): HttpBlockState | undefined {
    const block = this.runtime.blocks.find((entry) => entry.status === 'pending')
    if (!block) return undefined
    block.status = 'downloading'
    reader.interfaceId = this.networkOf(reader)?.id ?? reader.interfaceId
    block.interfaceId = reader.interfaceId
    reader.currentBlockIndex = block.index
    reader.status = 'downloading'
    this.host.scheduleUpdate()
    return block
  }

  private async runReader(reader: TelegramReaderState, self: ReaderRuntime): Promise<void> {
    const { state } = this.runtime
    let source: TelegramFileSource
    try {
      source = await this.source()
    } catch (cause) {
      this.host.failDownload(describeError(cause))
      reader.status = 'cancelled'
      return
    }

    while (state.status === 'downloading' && !self.controller.signal.aborted) {
      // Telegram asked everyone to slow down: every reader waits out the remainder.
      const rateWaitMs = this.rateLimitedUntil - Date.now()
      if (rateWaitMs > 0) {
        reader.status = 'retrying'
        await delay(rateWaitMs, self.wait)
        if ((this.runtime.state.status as DownloadStatus) !== 'downloading') break
        continue
      }
      if (!this.networkOf(reader)) {
        // No network is enabled right now: the manager pauses the download for this (see
        // reconcile), and the reader waits rather than spins.
        reader.status = 'pending'
        await delay(250, self.wait)
        continue
      }

      const block = this.claimBlock(reader)
      if (!block) {
        if (this.runtime.blocks.some((entry) => entry.status === 'downloading')) {
          // Stay available: a block in flight may be handed back by its reader failing.
          reader.status = 'pending'
          await delay(250, self.wait)
          continue
        }
        reader.status = 'completed'
        reader.currentBlockIndex = undefined
        break
      }

      const outcome = await this.runBlockStreamed(reader, self, block, source)
      if (outcome.type === 'completed') {
        self.failures = 0
        continue
      }
      if (outcome.type === 'stopped') {
        reader.status = (state.status as DownloadStatus) === 'paused' ? 'paused' : 'cancelled'
        reader.currentBlockIndex = undefined
        break
      }
      if (outcome.type === 'retry') {
        reader.status = 'retrying'
        this.host.scheduleUpdate()
        await delay(outcome.waitMs, self.wait)
        if ((this.runtime.state.status as DownloadStatus) !== 'downloading') {
          reader.status =
            (this.runtime.state.status as DownloadStatus) === 'paused' ? 'paused' : 'cancelled'
          reader.currentBlockIndex = undefined
          break
        }
        continue
      }
      // give-up: the reader is done, and the download fails with it.
      this.host.failDownload(describeError(outcome.error))
      reader.status = 'cancelled'
      reader.currentBlockIndex = undefined
      break
    }
  }

  /** Returns a block to the pool, keeping what was written of it. */
  private handBack(block: HttpBlockState): void {
    if (block.status === 'downloading') block.status = 'pending'
  }

  /** The request size for a chunk at `offset` within `block`: 1 MiB mid-file, over-asked up
   * to the 4096 alignment for a tail smaller than that (the answer is sliced down). */
  private chunkSize(block: HttpBlockState, offset: number): number {
    const end = block.rangeEnd === null ? Number.MAX_SAFE_INTEGER : block.rangeEnd + 1
    const request = Math.min(FILE_CHUNK_BYTES, end - offset)
    const aligned = Math.floor(request / 4096) * 4096
    return aligned > 0 ? aligned : 4096
  }

  /**
   * Fetches `firstBlock` with its connection kept full: the moment a chunk lands, the next
   * request goes out — for the same block when it runs long, else for the next pending
   * block, claimed then — and only then is the landed chunk written. The round trip of the
   * next chunk thus hides behind this one's disk write. All blocks this stream claims are
   * this function's to hand back when it stops early.
   */
  private async runBlockStreamed(
    reader: TelegramReaderState,
    self: ReaderRuntime,
    firstBlock: HttpBlockState,
    source: TelegramFileSource
  ): Promise<BlockOutcome> {
    const { state, meters } = this.runtime
    const networkId = reader.interfaceId
    const endOf = (block: HttpBlockState): number =>
      block.rangeEnd === null ? Number.MAX_SAFE_INTEGER : block.rangeEnd + 1

    const fire = (block: HttpBlockState, offset: number): Prefetch => ({
      block,
      offset,
      promise: source
        .request(offset, this.chunkSize(block, offset), self.controller.signal)
        .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
    })

    let prefetch: Prefetch = fire(firstBlock, firstBlock.rangeStart + firstBlock.bytesDownloaded)

    while (true) {
      const { block, offset } = prefetch
      const settled = await prefetch.promise
      if (settled instanceof Error) {
        this.handBack(block)
        if (self.controller.signal.aborted || (state.status as DownloadStatus) !== 'downloading') {
          return { type: 'stopped' }
        }
        return this.asOutcome(self, settled)
      }
      if (settled.length === 0) {
        if (block.rangeEnd !== null) {
          this.handBack(block)
          return {
            type: 'give-up',
            error: new Error('Telegram closed this file early — resume to try again.')
          }
        }
        // The end of the photo: its size is known now, and the block with it.
        state.totalBytes = offset
        advanceBlock(block, networkId, offset - block.rangeStart)
        block.status = 'completed'
        recomputeAggregates(state, this.runtime.blocks)
        this.host.scheduleUpdate()
        return { type: 'completed' }
      }

      const remaining = endOf(block) - offset
      const usable = Math.min(settled.length, remaining)
      const nextOffset = offset + usable
      const blockFinished = nextOffset >= endOf(block)

      // Claim and fire the next chunk before writing this one.
      let next: Prefetch | undefined
      if ((state.status as DownloadStatus) === 'downloading' && !self.controller.signal.aborted) {
        if (!blockFinished) {
          next = fire(block, nextOffset)
        } else {
          const claimed = this.claimBlock(reader)
          if (claimed) next = fire(claimed, claimed.rangeStart + claimed.bytesDownloaded)
        }
      }

      try {
        await this.host.limits.take(networkId, usable)
        await this.write(offset, settled.subarray(0, usable))
      } catch (error) {
        // The write side (a full disk, a dropped drive) isn't Telegram's doing: end the
        // download with what it says, keeping the download resumable.
        if (next) await next.promise
        this.handBack(block)
        if (next && next.block !== block) this.handBack(next.block)
        this.host.failDownload(describeError(error))
        return { type: 'stopped' }
      }

      const gained = advanceBlock(block, networkId, nextOffset - block.rangeStart)
      if (gained > 0) {
        state.bytesDownloaded += gained
        reader.bytesDownloaded += gained
        meters.add(reader.id, networkId, gained)
      }
      if (blockFinished && block.rangeEnd !== null) {
        advanceBlock(block, networkId, block.rangeEnd - block.rangeStart + 1)
        block.status = 'completed'
        recomputeAggregates(state, this.runtime.blocks)
      }
      this.host.scheduleUpdate()

      if (next) {
        prefetch = next
        continue
      }
      if (blockFinished) return { type: 'completed' }
      // Nothing more to claim (the download may be ending) — the unfinished block is this
      // reader's still, so its next chunk goes out now rather than never.
      prefetch = fire(block, nextOffset)
    }
  }

  /** Reads failure kinds the transfer acts on: a rate limit becomes a wait every reader
   * shares, auth and missing files end the download, the rest retry on this reader. */
  private asOutcome(self: ReaderRuntime, error: unknown): BlockOutcome {
    if (error instanceof TelegramFileError) {
      if (error.kind === 'rate') {
        const waitMs = (error.waitSeconds ?? 1) * 1000
        if (waitMs > RATE_WAIT_MAX_MS) return { type: 'give-up', error }
        this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + waitMs)
        return { type: 'retry', waitMs }
      }
      if (error.kind === 'auth' || error.kind === 'missing') {
        return { type: 'give-up', error }
      }
    }
    // A connection or server failure: back off and take the block again. Progress made resets
    // the count, as the HTTP transfer's does.
    self.failures += 1
    if (self.failures > MAX_RETRIES) return { type: 'give-up', error }
    const exact = Math.min(RETRY_BASE_MS * 2 ** (self.failures - 1), RETRY_MAX_MS)
    return { type: 'retry', waitMs: exact * (0.8 + 0.4 * Math.random()) }
  }

  private write(offset: number, buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const writer = this.runtime.file.writer(offset)
      writer.on('error', reject)
      writer.end(buffer, () => {
        writer.off('error', reject)
        resolve()
      })
    })
  }
}

/** A download of a photo, whose byte size Telegram doesn't say ahead of time: one reader runs
 * it to the end, and the size is known once the last chunk lands. */
export function photoDownload(request: StartTelegramDownloadRequest): boolean {
  return request.mediaType === 'photo'
}
