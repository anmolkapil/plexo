import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { app, Notification, type BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import type {
  AddLinksResult,
  AppSettings,
  DownloadState,
  DownloadStatus,
  QueueItem,
  QueueLink,
  QueueState
} from '../../shared/types'
import { isCancelled, isFailure, nameOf } from '../../shared/queueItem'
import type { DownloadEvent, DownloadManager } from '../download/downloadManager'
import { probeUrl } from '../download/probe'
import { readJson, updateJson } from '../jsonFile'
import type { NetworkMonitor } from '../network/interfaces'
import { testKnobs } from '../testKnobs'
import {
  classifyDownload,
  classifyError,
  folderProblem,
  LinkExpiredError,
  type Failure
} from './failures'
import { sanitizeLink, sanitizeStoredItem } from './items'

/** Downloads started for an item before a failure that isn't the link's fault (a server
 * error, a dropped connection) stops being retried on its own. */
const MAX_AUTO_ATTEMPTS = 2
/** How long an automatic retry waits: long enough for a server's moment of trouble to pass.
 * The item keeps its place meanwhile, and the ones after it go ahead. */
const AUTO_RETRY_DELAY_MS = testKnobs.retryBaseDelayMs * 10
/** Pasted links are looked up (size, name) in the background, this many at a time. */
const LOOKUP_CONCURRENCY = 2
const MAX_ITEMS = 5000
/** queue.json may be briefly locked (antivirus, a sync client): read again this many times. */
const READ_TRIES = 5

/**
 * Plexo's download queue: links waiting their turn, downloaded one at a time — one file already
 * has every network to itself, so a second at once would only split them. Each item becomes an
 * ordinary download (see DownloadManager); the queue decides when, and follows what becomes of it.
 *
 * Saved to queue.json on every change. After a relaunch the queue comes back stopped, with its
 * current download paused as the manager restores it — nothing starts until the user says so.
 */
export class DownloadQueue {
  private items: QueueItem[] = []
  private running = false
  private destinationDir = ''
  /** The current download failed outside the queue: the user moves on from it before the queue
   * does, rather than having it swept away. */
  private blocked = false
  /** queue.json couldn't be read: nothing is saved over it this session, lest what it holds be
   * lost to a moment's lock. */
  private loadError: string | undefined
  private manager: DownloadManager | null = null
  readonly loaded: Promise<void>
  /** Everything that talks to the download manager runs one step at a time, in order. */
  private chain: Promise<void> = Promise.resolve()
  private pumpQueued = false
  private emitQueued = false
  private saveQueued = false
  /** The last save, for flush to wait on. */
  private saving: Promise<void> = Promise.resolve()
  private lookingUp = new Set<string>()
  /** Each download's status as last seen: what tells a change of status from progress. */
  private seenStatus = new Map<string, DownloadStatus>()
  /** Running, but no network is connected: see networksChanged. */
  private waitingForNetwork = false
  /** Why the queue stopped itself, till it's started again (see stopBecause). */
  private stoppedBecause: string | undefined
  /** Wakes the queue for the earliest automatic retry. */
  private retryTimer: NodeJS.Timeout | null = null
  /** Tallied since the queue last had nothing to do, for the "queue finished" notification. */
  private session = { completed: 0, failed: 0, lastName: '' }

  constructor(
    private getWindow: () => BrowserWindow | null,
    private networks: NetworkMonitor,
    /** The app's settings: where downloads go by default, and which networks are switched off. */
    private settings: () => Promise<AppSettings & { downloadsDir: string }>
  ) {
    this.loaded = this.load()
  }

  private filePath(): string {
    return join(app.getPath('userData'), 'queue.json')
  }

  private async load(): Promise<void> {
    let file: unknown
    for (let attempt = 1; ; attempt++) {
      try {
        file = await readJson(this.filePath())
        break
      } catch (error) {
        if (attempt < READ_TRIES) {
          await sleep(100 * attempt)
          continue
        }
        console.error('[plexo] failed to read queue.json', error)
        this.loadError =
          'Plexo couldn’t read its saved queue, so changes this session won’t be saved. Restart Plexo to try again.'
        break
      }
    }
    const saved = typeof file === 'object' && file !== null ? (file as Record<string, unknown>) : {}
    const destination = saved.destinationDir
    const settings = await this.settings().catch(() => null)
    this.destinationDir =
      typeof destination === 'string' && isAbsolute(destination)
        ? destination
        : (settings?.destinationDir ?? settings?.downloadsDir ?? '')
    const items = Array.isArray(saved.items) ? saved.items : []
    const ids = new Set<string>()
    for (const value of items.slice(0, MAX_ITEMS)) {
      const item = sanitizeStoredItem(value)
      if (!item || ids.has(item.id)) continue
      ids.add(item.id)
      // Interrupted while being checked: it simply hadn't started.
      if (item.status === 'starting') item.status = 'queued'
      this.items.push(item)
    }
  }

  /** What the queue still wants of the downloads it parked (see DownloadManager): each by its
   * download or item id — or all of them, when the queue couldn't be read to say. */
  async retainedDownloads(): Promise<ReadonlySet<string> | 'all'> {
    await this.loaded
    if (this.loadError) return 'all'
    const retained = new Set<string>()
    for (const item of this.items) {
      if (item.status === 'completed') continue
      retained.add(item.id)
      if (item.downloadId) retained.add(item.downloadId)
    }
    return retained
  }

  /** Connects the queue to the download manager, once both have loaded, and squares what the
   * queue remembers with what the manager restored — including a download it started just
   * before the app quit, faster than it could note which. */
  async attach(manager: DownloadManager): Promise<void> {
    await this.loaded
    this.manager = manager
    manager.subscribe((event) => this.onDownloadEvent(event))
    await this.enqueue(async () => {
      for (const item of this.items) {
        if (item.status === 'completed') continue
        item.downloadId ??= await manager.downloadForQueueItem(item.id)
        const state = item.downloadId ? await manager.stateOf(item.downloadId) : undefined
        if (state) this.seenStatus.set(state.id, state.status)
        if (!state) {
          item.downloadId = undefined
          if (item.status === 'active') item.status = 'queued'
          continue
        }
        if (item.status === 'queued' && state.status !== 'error') item.status = 'active'
        if (item.status === 'active') this.applyState(item, state)
      }
    })
    this.changed()
    this.startLookups()
  }

  // --- what the window sees -------------------------------------------------------------------

  getState(): QueueState {
    return {
      running: this.running,
      destinationDir: this.destinationDir,
      blocked: this.blocked,
      loadError: this.loadError,
      waitingForNetwork: this.running && this.waitingForNetwork,
      stoppedBecause: this.stoppedBecause,
      items: this.items.map((item) => ({ ...item }))
    }
  }

  private scheduleEmit(): void {
    if (this.emitQueued) return
    this.emitQueued = true
    setImmediate(() => {
      this.emitQueued = false
      const window = this.getWindow()
      if (window && !window.isDestroyed()) {
        window.webContents.send(IpcChannels.queueUpdated, this.getState())
      }
    })
  }

  private scheduleSave(): void {
    if (this.saveQueued || this.loadError) return
    this.saveQueued = true
    setImmediate(() => {
      if (this.saveQueued) void this.save()
    })
  }

  private save(): Promise<void> {
    this.saveQueued = false
    const file = {
      version: 1,
      destinationDir: this.destinationDir || undefined,
      items: this.items
    }
    this.saving = updateJson(this.filePath(), () => file).catch((error) =>
      console.error('[plexo] failed to save queue.json', error)
    )
    return this.saving
  }

  /** Saves now what's waiting to be saved, and waits for it: for the app quitting. */
  async flush(): Promise<void> {
    if (this.saveQueued) await this.save()
    else await this.saving
  }

  /** Something the window shows, or the next launch needs, changed. */
  private changed(): void {
    this.scheduleSave()
    this.scheduleEmit()
  }

  // --- adding ---------------------------------------------------------------------------------

  /** Adds links to the end of the queue. A link already waiting (or downloading) is skipped. */
  async addLinks(links: QueueLink[], options: { start: boolean }): Promise<AddLinksResult> {
    await this.loaded
    const result: AddLinksResult = { added: 0, duplicates: 0 }
    const now = Date.now()
    for (const raw of links) {
      const link = sanitizeLink(raw)
      if (!link) continue
      const waiting = (item: QueueItem): boolean =>
        item.status === 'queued' || item.status === 'starting' || item.status === 'active'
      if (this.items.some((item) => waiting(item) && item.url === link.url)) {
        result.duplicates++
        continue
      }
      // Failed or cancelled already: that item goes again — from what it kept, if it kept
      // anything — rather than a second one from nothing.
      const again = this.items.find((item) => item.status === 'failed' && item.url === link.url)
      if (again) {
        this.requeue(again)
        again.attempts = 0
        result.added++
        continue
      }
      if (this.items.length >= MAX_ITEMS) break
      this.items.push({
        id: randomUUID(),
        url: link.url,
        addedAt: now,
        status: 'queued',
        attempts: 0
      })
      result.added++
    }
    if (result.added > 0) {
      if (options.start) this.run()
      this.changed()
      this.startLookups()
      this.pump()
    }
    return result
  }

  private requeue(item: QueueItem): void {
    item.status = 'queued'
    item.error = undefined
    item.problem = undefined
    item.finishedAt = undefined
    item.retryAt = undefined
  }

  private finish(item: QueueItem, status: 'completed' | 'failed', failure?: Failure): void {
    item.status = status
    item.finishedAt = Date.now()
    item.error = failure?.error
    item.problem = failure?.problem
  }

  /**
   * Looks up the size and name of pasted links, a couple at a time, so the list says what it
   * holds before each one's turn. A link that plainly doesn't work is marked failed now rather
   * than when its turn comes.
   */
  private startLookups(): void {
    while (this.lookingUp.size < LOOKUP_CONCURRENCY) {
      const item = this.items.find(
        (candidate) =>
          candidate.status === 'queued' &&
          candidate.totalBytes === undefined &&
          !candidate.downloadId &&
          !this.lookingUp.has(candidate.id)
      )
      if (!item) return
      this.lookingUp.add(item.id)
      void this.lookUp(item).finally(() => {
        this.lookingUp.delete(item.id)
        this.startLookups()
      })
    }
  }

  private async lookUp(item: QueueItem): Promise<void> {
    const url = item.url
    try {
      const probe = await probeUrl(url)
      if (item.url !== url || item.status !== 'queued') return
      item.totalBytes = probe.totalBytes ?? 0
      item.fileName ||= probe.suggestedFileName
    } catch (error) {
      if (item.url !== url || item.status !== 'queued') return
      const failure = classifyError(error)
      // Only a link that plainly doesn't work fails now; anything else gets its turn.
      if (failure.problem === 'expired') this.fail(item, failure)
      else item.totalBytes = 0
    }
    this.changed()
  }

  // --- commands from the window -----------------------------------------------------------

  private find(id: string): QueueItem | undefined {
    return this.items.find((item) => item.id === id)
  }

  /** Sets the queue going, whatever set it off: whatever stopped it no longer stands. */
  private run(): void {
    this.running = true
    this.stoppedBecause = undefined
  }

  async start(): Promise<void> {
    await this.loaded
    this.run()
    this.blocked = false
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      if (current?.status === 'paused' && this.itemFor(current.id)) {
        this.manager?.resume(current.id)
      }
    })
    this.pump()
  }

  async stop(): Promise<void> {
    await this.loaded
    this.running = false
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      if (current?.status === 'downloading' && this.itemFor(current.id)) {
        await this.manager?.pause(current.id)
      }
    })
  }

  async retry(id: string): Promise<void> {
    await this.retryWhere((item) => item.id === id)
  }

  /** Retries every item that failed — not those the user cancelled. */
  async retryFailed(): Promise<void> {
    await this.retryWhere(isFailure)
  }

  /** Sends failed items back to wait their turn. A retry is asked for, not automatic: each gets
   * its own full set of attempts. */
  private async retryWhere(which: (item: QueueItem) => boolean): Promise<void> {
    await this.loaded
    const failed = this.items.filter((item) => item.status === 'failed' && which(item))
    if (failed.length === 0) return
    for (const item of failed) {
      this.requeue(item)
      item.attempts = 0
    }
    this.run()
    this.changed()
    this.pump()
  }

  async remove(id: string): Promise<void> {
    await this.loaded
    const item = this.find(id)
    if (!item) return
    this.items = this.items.filter((entry) => entry !== item)
    this.changed()
    const downloadId = item.downloadId
    if (downloadId) {
      // Removing the download discards what it had fetched — never the finished file.
      await this.enqueue(async () => {
        await this.manager?.remove(downloadId)
      })
    }
    this.pump()
  }

  /** Moves a waiting item one place up or down the line of waiting items. */
  async move(id: string, offset: -1 | 1): Promise<void> {
    await this.loaded
    const index = this.items.findIndex((entry) => entry.id === id)
    if (index < 0 || this.items[index].status !== 'queued') return
    let target = index + offset
    while (target >= 0 && target < this.items.length && this.items[target].status !== 'queued') {
      target += offset
    }
    if (target < 0 || target >= this.items.length) return
    ;[this.items[index], this.items[target]] = [this.items[target], this.items[index]]
    this.changed()
  }

  async clearFinished(): Promise<void> {
    await this.loaded
    // Done with, either way: saved, or cancelled.
    const done = (item: QueueItem): boolean => item.status === 'completed' || isCancelled(item)
    const finished = this.items.filter(done)
    if (finished.length === 0) return
    this.items = this.items.filter((item) => !done(item))
    this.changed()
    await this.enqueue(async () => {
      const current = await this.manager?.currentState()
      for (const item of finished) {
        // The one on screen stays there until the user moves on from it.
        if (item.downloadId && item.downloadId !== current?.id) {
          await this.manager?.remove(item.downloadId)
        }
      }
    })
  }

  async setDestination(dir: string): Promise<void> {
    if (typeof dir !== 'string' || !isAbsolute(dir)) return
    // Set before the saved queue has loaded, it would be overwritten by the saved folder.
    await this.loaded
    this.destinationDir = dir
    this.stoppedBecause = undefined
    this.changed()
  }

  // --- following the downloads ----------------------------------------------------------------

  private itemFor(downloadId: string): QueueItem | undefined {
    return this.items.find((item) => item.downloadId === downloadId)
  }

  private onDownloadEvent(event: DownloadEvent): void {
    if (event.type === 'removed') {
      this.seenStatus.delete(event.id)
      const item = this.itemFor(event.id)
      if (item) {
        item.downloadId = undefined
        // Removed while it was the current download (New Download on its screen): it is done
        // with, as far as the user is concerned.
        if (item.status === 'active') {
          this.finish(item, 'failed', { problem: 'cancelled', error: 'Removed', retry: false })
        }
        this.changed()
      }
      // Either way, the way may be free now.
      this.pump()
      return
    }
    const { id, status } = event.state
    const previous = this.seenStatus.get(id)
    const statusChanged = previous !== status
    this.seenStatus.set(id, status)
    const item = this.itemFor(id)
    if (item) {
      // One of the queue's resumed on the main screen (paused, or failed): the queue carries on
      // with it, rather than stopping once that file is done.
      const resumed = status === 'downloading' && (previous === 'paused' || previous === 'error')
      if (resumed && !this.running) {
        this.run()
        this.changed()
      }
      this.applyState(item, event.state)
    }
    // A download of the user's own that finished, one way or another, frees the way.
    else if (statusChanged && status !== 'downloading' && status !== 'paused') this.pump()
  }

  /** Follows a download's state onto its item. Called for every update the download sends, so
   * anything more than bookkeeping only happens when its status changes. */
  private applyState(item: QueueItem, state: Readonly<Omit<DownloadState, 'blocks'>>): void {
    item.bytesDownloaded = state.bytesDownloaded
    if (state.totalBytes > 0) item.totalBytes = state.totalBytes
    switch (state.status) {
      case 'downloading':
      case 'paused':
        if (item.status !== 'active') {
          // Resumed outside the queue — Resume on its error screen.
          item.status = 'active'
          item.error = undefined
          item.problem = undefined
          item.retryAt = undefined
          this.changed()
        }
        return
      case 'completed':
        if (item.status === 'completed') return
        this.finish(item, 'completed')
        item.finishedAt = state.completedAt ?? item.finishedAt
        item.destinationPath = state.destinationPath
        item.fileName = state.fileName
        this.session.completed++
        this.session.lastName = state.fileName
        this.changed()
        this.pump()
        return
      case 'error': {
        if (item.status !== 'active') return
        this.fail(item, classifyDownload(state.refusal, state.error ?? 'The download failed'))
        const downloadId = state.id
        // Kept, with what it downloaded, for a retry to pick up — but out of the way of the next.
        void this.enqueue(async () => {
          await this.manager?.park(downloadId)
        })
        this.pump()
        return
      }
      case 'cancelled':
        if (item.status !== 'active') return
        // Cancelling throws the download away, so a retry starts over. The item keeps its id
        // while it's on screen: Download Again there sends the item back to the queue.
        this.fail(item, { problem: 'cancelled', error: 'Cancelled', retry: false })
        item.bytesDownloaded = 0
        this.pump()
        return
    }
  }

  /** Marks an item failed — or, for a failure a moment could fix that hasn't used up its
   * attempts, has it wait a moment for another go (see AUTO_RETRY_DELAY_MS). */
  private fail(item: QueueItem, failure: Failure): void {
    if (failure.retry && item.attempts < MAX_AUTO_ATTEMPTS) {
      this.requeue(item)
      item.retryAt = Date.now() + AUTO_RETRY_DELAY_MS
    } else {
      this.finish(item, 'failed', failure)
      // Cancelling is the user's choice, not a failure to report.
      if (failure.problem !== 'cancelled') {
        this.session.failed++
        this.session.lastName = nameOf(item)
      }
    }
    this.changed()
  }

  // --- running the queue ----------------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((error) => {
      console.error('[plexo] queue step failed', error)
    })
    this.chain = next
    return next
  }

  /** Starts the next item if the queue is running and nothing else is downloading. Safe to call
   * any time; calls made while one is waiting to run fold into it. */
  pump(): void {
    if (this.pumpQueued) return
    this.pumpQueued = true
    void this.enqueue(async () => {
      this.pumpQueued = false
      await this.startNext()
    })
  }

  /** The networks to start a download on: every one connected, bar those switched off on the
   * start screen — unless that would leave none. */
  private async networksToUse(): Promise<string[]> {
    const connected = (await this.networks.refresh()).map((iface) => iface.id)
    const excluded = new Set((await this.settings().catch(() => null))?.excludedNetworks ?? [])
    const chosen = connected.filter((id) => !excluded.has(id))
    return chosen.length > 0 ? chosen : connected
  }

  private async startNext(): Promise<void> {
    const manager = this.manager
    if (!manager || !this.running) return
    if (await manager.isBusy()) return

    // A download of the user's own that failed stays on screen, resumable, until they move on
    // from it: starting the next item would sweep it away.
    const current = await manager.currentState()
    const blocked = current?.status === 'error' && !this.itemFor(current.id)
    if (blocked !== this.blocked) {
      this.blocked = blocked
      this.scheduleEmit()
    }
    if (blocked) return

    // The first waiting item not held back for an automatic retry (see fail).
    const now = Date.now()
    const waiting = this.items.filter((entry) => entry.status === 'queued')
    const item = waiting.find((entry) => (entry.retryAt ?? 0) <= now)
    if (!item) {
      const retryAt = Math.min(...waiting.map((entry) => entry.retryAt ?? Infinity))
      if (retryAt < Infinity) this.wakeAt(retryAt)
      else this.finishSession()
      return
    }

    // With no network at all, every item would fail in turn: wait for one (see networksChanged).
    const interfaceIds = await this.networksToUse()
    const offline = interfaceIds.length === 0
    if (offline !== this.waitingForNetwork) {
      this.waitingForNetwork = offline
      this.scheduleEmit()
    }
    if (offline) return

    // The queue's finished downloads are done with; only the one on screen is still shown.
    for (const done of this.items) {
      if (done.status === 'completed' && done.downloadId) {
        const downloadId = done.downloadId
        done.downloadId = undefined
        await manager.remove(downloadId)
      }
    }

    item.status = 'starting'
    item.attempts++
    item.error = undefined
    item.problem = undefined
    item.retryAt = undefined
    this.changed()

    try {
      const probe = await probeUrl(item.url)
      if (!this.items.includes(item)) return // removed meanwhile
      if (!this.running) {
        // Paused while the link was being checked: it waits, not started.
        item.status = 'queued'
        item.attempts--
        this.changed()
        return
      }
      // What a file host sends once a link has run out: its own page.
      if (probe.contentType?.startsWith('text/html') && !probe.attachment) {
        throw new LinkExpiredError(
          'The link opened a web page instead of the file, so it has probably expired.'
        )
      }

      if (item.downloadId) {
        const resumed = await manager.resumeParked(item.downloadId, { url: probe.finalUrl })
        if (resumed) {
          item.status = 'active'
          this.changed()
          return
        }
        // Nothing to resume from after all — its partial file went missing, or where the link
        // leads now serves another file: start over from this link.
        const stale = item.downloadId
        item.downloadId = undefined
        await manager.remove(stale)
      }

      const downloadId = await manager.start({
        url: probe.finalUrl,
        destinationDir: this.destinationDir,
        suggestedFileName: probe.suggestedFileName,
        totalBytes: probe.totalBytes ?? 0,
        supportsRanges: probe.supportsRanges && probe.totalBytes !== null,
        interfaceIds,
        etag: probe.etag,
        lastModified: probe.lastModified,
        queueItemId: item.id
      })
      if (!this.items.includes(item)) {
        // Removed while it was starting: its download goes with it.
        await manager.remove(downloadId)
        return
      }
      item.downloadId = downloadId
      item.status = 'active'
      item.totalBytes = probe.totalBytes ?? item.totalBytes
      this.changed()
      // Anything it already did went by before it was this item's (see applyState).
      const state = await manager.stateOf(downloadId)
      if (state) this.applyState(item, state)
    } catch (error) {
      if (!this.items.includes(item)) return
      const problem = folderProblem(error, this.destinationDir)
      if (problem || !this.running || (await manager.isBusy())) {
        // Its folder can't be saved to — nor could any other item's be — or the queue was paused,
        // or the user started a download of their own, meanwhile: not this item's failure. It
        // waits.
        item.status = 'queued'
        item.attempts--
        if (problem) this.stopBecause(problem)
        this.changed()
        return
      }
      this.fail(item, classifyError(error))
    }
    // Failed without a download to report back: go on to the next one.
    if (item.status !== 'active') this.pump()
  }

  /** Networks came or went. The queue waiting for one carries on once one is there. */
  networksChanged(networks: readonly unknown[]): void {
    if (this.waitingForNetwork && networks.length > 0) this.pump()
  }

  /** Runs the queue again at `at`, for an automatic retry due then. */
  private wakeAt(at: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        this.pump()
      },
      Math.max(0, at - Date.now())
    )
  }

  /** Stops the queue over something only the user can fix, and says so — here and, as they may
   * well be away, in a notification. */
  private stopBecause(problem: string): void {
    this.running = false
    this.stoppedBecause = problem
    this.changed()
    if (testKnobs.userDataDir || !Notification.isSupported()) return
    try {
      new Notification({ title: 'Queue paused', body: problem }).show()
    } catch {
      // Best-effort notification
    }
  }

  /** Nothing left to start: says how it went — in one notification, rather than one per file
   * (the queue's downloads don't notify on their own; see DownloadManager.notifyAbout). */
  private finishSession(): void {
    const { completed, failed, lastName } = this.session
    this.session = { completed: 0, failed: 0, lastName: '' }
    if (completed + failed === 0 || testKnobs.userDataDir || !Notification.isSupported()) return
    const body =
      completed + failed === 1
        ? completed === 1
          ? `${lastName} has finished downloading.`
          : `${lastName} couldn’t be downloaded.`
        : failed > 0
          ? `${completed} downloaded, ${failed} failed.`
          : `All ${completed} files downloaded.`
    try {
      new Notification({ title: 'Queue finished', body }).show()
    } catch {
      // Best-effort notification
    }
  }
}
