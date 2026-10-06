import { Writable } from 'node:stream'

const MiB = 1024 * 1024
/** HTTP write tuning, in MiB. Payload is allocated on demand; limits include in-flight writes.
 * Keep perFileMiB <= sharedMiB. These caps exclude Electron, stream and OS-cache memory. */
export const HTTP_WRITE_CONFIG = {
  perFileMiB: 32,
  sharedMiB: 128,
  batchMiB: 1,
  flushMs: 10
} as const

const BATCH_BYTES = HTTP_WRITE_CONFIG.batchMiB * MiB
const FLUSH_MS = HTTP_WRITE_CONFIG.flushMs
/** Charges queued AND in-flight payloads. Unadmitted packets stay under stream backpressure. */
export class WriteBudget {
  used = 0
  peak = 0
  private readonly byFile = new Map<WriteQueue, number>()
  private readonly waiters = new Set<() => void>()

  constructor(
    readonly limit = HTTP_WRITE_CONFIG.sharedMiB * MiB,
    readonly perFile = HTTP_WRITE_CONFIG.perFileMiB * MiB
  ) {}

  acquire(file: WriteQueue, bytes: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const tryAcquire = (): void => {
        if (signal.aborted) {
          this.waiters.delete(tryAcquire)
          signal.removeEventListener('abort', tryAcquire)
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        const used = this.byFile.get(file) ?? 0
        if (this.used + bytes > this.limit || used + bytes > this.perFile) return
        this.waiters.delete(tryAcquire)
        signal.removeEventListener('abort', tryAcquire)
        this.used += bytes
        this.peak = Math.max(this.peak, this.used)
        this.byFile.set(file, used + bytes)
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.used -= bytes
          const remaining = (this.byFile.get(file) ?? bytes) - bytes
          if (remaining) this.byFile.set(file, remaining)
          else this.byFile.delete(file)
          for (const wake of [...this.waiters]) wake()
        })
      }
      this.waiters.add(tryAcquire)
      signal.addEventListener('abort', tryAcquire, { once: true })
      tryAcquire()
    })
  }
}

export const httpWriteBudget = new WriteBudget()

interface Entry {
  owner: QueuedWriter
  position: number
  buffer: Buffer
  finish: (error?: Error) => void
}

/** Batches available adjacent offsets; never waits for a missing range elsewhere in the file. */
export class WriteQueue {
  private entries: Entry[] = []
  private readonly pending = new Map<QueuedWriter, Set<Promise<void>>>()
  private timer?: NodeJS.Timeout
  private flushing = false
  private draining = 0

  constructor(
    private readonly writeBatch: (buffers: Buffer[], position: number) => Promise<void>,
    readonly budget = httpWriteBudget
  ) {}

  writer(position: number): QueuedWriter {
    return new QueuedWriter(this, position)
  }

  async submit(owner: QueuedWriter, position: number, buffer: Buffer): Promise<void> {
    let finish!: (error?: Error) => void
    const completed = new Promise<void>((resolve, reject) => {
      finish = (error) => {
        if (error) reject(error)
        else {
          owner.written(buffer.length)
          resolve()
        }
      }
    })
    let tasks = this.pending.get(owner)
    if (!tasks) this.pending.set(owner, (tasks = new Set()))
    tasks.add(completed)
    void completed
      .catch(() => {})
      .finally(() => {
        tasks!.delete(completed)
        if (!tasks!.size) this.pending.delete(owner)
      })
    try {
      const release = await this.budget.acquire(this, buffer.length, owner.stop.signal)
      if (owner.destroyed) {
        release()
        throw new DOMException('Aborted', 'AbortError')
      }
      this.entries.push({
        owner,
        position,
        buffer,
        finish: (error) => {
          release()
          finish(error)
          if (error && !owner.destroyed) owner.destroy(error)
        }
      })
      this.schedule()
    } catch (error) {
      finish(error as Error)
      throw error
    }
  }

  async drain(owner?: QueuedWriter): Promise<void> {
    const tasks = owner
      ? [...(this.pending.get(owner) ?? [])]
      : [...this.pending.values()].flatMap((tasks) => [...tasks])
    this.draining++
    this.schedule()
    try {
      await Promise.all(tasks)
    } finally {
      this.draining--
    }
  }

  async cancel(owner: QueuedWriter): Promise<void> {
    owner.stop.abort()
    const abandoned = this.entries.filter((entry) => entry.owner === owner)
    this.entries = this.entries.filter((entry) => entry.owner !== owner)
    for (const entry of abandoned) entry.finish(new DOMException('Aborted', 'AbortError'))
    // Rejections must not let close overtake another in-flight write from this owner.
    await Promise.allSettled([...(this.pending.get(owner) ?? [])])
  }

  private schedule(): void {
    if (this.flushing || !this.entries.length) return
    const bytes = this.entries.reduce((sum, entry) => sum + entry.buffer.length, 0)
    if (this.draining || bytes >= BATCH_BYTES) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      void this.flush()
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, FLUSH_MS)
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.entries.length) return
    this.flushing = true
    this.entries.sort((a, b) => a.position - b.position)
    const batch = [this.entries.shift()!]
    let bytes = batch[0].buffer.length
    let end = batch[0].position + bytes
    while (this.entries.length && batch.length < 64) {
      const next = this.entries[0]
      if (next.position !== end || bytes + next.buffer.length > BATCH_BYTES) break
      batch.push(this.entries.shift()!)
      bytes += next.buffer.length
      end += next.buffer.length
    }
    try {
      await this.writeBatch(
        batch.map((entry) => entry.buffer),
        batch[0].position
      )
      for (const entry of batch) entry.finish()
    } catch (error) {
      const failed = [...batch, ...this.entries.splice(0)]
      for (const entry of failed) entry.finish(error as Error)
    } finally {
      this.flushing = false
      this.schedule()
    }
  }
}

/** Admission callbacks provide backpressure; 'written' events alone credit saved progress. */
export class QueuedWriter extends Writable {
  readonly tracksWriteCompletion = true
  readonly stop = new AbortController()
  private completed = 0

  constructor(
    private readonly queue: WriteQueue,
    private position: number
  ) {
    super({ highWaterMark: 64 * 1024 })
  }

  written(bytes: number): void {
    this.completed += bytes
    if (!this.destroyed) this.emit('written', this.completed)
  }

  override _write(
    buffer: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error) => void
  ): void {
    // Split unusually large packets so even a small test budget can make progress.
    const size = Math.min(256 * 1024, this.queue.budget.limit, this.queue.budget.perFile)
    const submit = async (): Promise<void> => {
      for (let at = 0; at < buffer.length; at += size) {
        const part = buffer.subarray(at, at + size)
        await this.queue.submit(this, this.position, part)
        this.position += part.length
      }
    }
    void submit().then(
      () => callback(),
      (error: Error) => callback(error)
    )
  }

  override _final(callback: (error?: Error) => void): void {
    void this.queue.drain(this).then(
      () => callback(),
      (error: Error) => callback(error)
    )
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    void this.queue.cancel(this).then(
      () => callback(error),
      () => callback(error)
    )
  }
}
