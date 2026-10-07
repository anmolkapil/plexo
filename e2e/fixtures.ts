import type {} from '../src/preload/globals'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import type { IpcContract } from '../src/shared/ipc-contract'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import type {
  DownloadState,
  DownloadStatus,
  DownloadUpdate,
  HttpDownloadState,
  TorrentDownloadState
} from '../src/shared/types'
import { Origin, sha256, type OriginOptions } from './origin'

export { expect }

export function expectHttp(state: DownloadState): HttpDownloadState {
  expect(state.kind).toBe('http')
  if (state.kind !== 'http') throw new Error('Expected an HTTP download')
  return state
}

export function expectTorrent(state: DownloadState): TorrentDownloadState {
  expect(state.kind).toBe('torrent')
  if (state.kind !== 'torrent') throw new Error('Expected a torrent download')
  return state
}

export const PROJECT_ROOT = resolve(__dirname, '..')

/** Every raw Electron launch needs the same CI sandbox policy. */
export function electronArgs(entry: string, args: string[] = []): string[] {
  return [entry, ...args, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
}

/** Small blocks so a ~1 MB test file still splits into many of them. */
export const BLOCK = 64 * 1024

/**
 * The second test "network": this machine's LAN address. A request bound to it still reaches
 * the loopback test server, but arrives from a different source address — which is how the
 * server tells the two networks apart. Found (and checked to work) by global-setup.ts; null
 * where there's no usable one, and the multi-network tests skip.
 */
export const LAN_ADDRESS = process.env.PLEXO_E2E_LAN || null

export const NETWORKS = LAN_ADDRESS
  ? { a: '127.0.0.1', b: LAN_ADDRESS }
  : ({ a: '127.0.0.1' } as Record<string, string>)

export function interfacesEnv(networks: Record<string, string>): string {
  return Object.entries(networks)
    .map(([id, address]) => `${id}=${address}`)
    .join(',')
}

type Api = {
  [K in keyof IpcContract]: (...args: IpcContract[K]['args']) => Promise<IpcContract[K]['result']>
}

interface StartOptions {
  networks?: string[]
  /** Streams per network, fixed so a test can count requests; 'auto' lets the app decide. */
  connections?: number | 'auto'
  /** With connections 'auto': the streams per network picked on the start screen. */
  streamsPerNetwork?: number
  fileName?: string
  destinationDir?: string
  /** For a torrent: the files to download, by index. */
  selectedFiles?: number[]
}

interface Tracked {
  expectedSha: string
  /** Files already in the destination folder before this download started. */
  destBefore: string[]
  destinationDir: string
}

/**
 * Drives one Plexo instance through the same `window.plexo` API the renderer uses — nothing
 * below this reaches into the main process's internals, so refactoring them can't break a test
 * that still describes correct behavior.
 */
export class PlexoApp {
  electronApp!: ElectronApplication
  page!: Page
  /** Every downloadUpdated state, one array per app launch (a relaunch starts a new one). */
  readonly sessions: DownloadState[][] = []
  /** The same, as the window was sent them: only the blocks that changed. */
  readonly updates: DownloadUpdate[][] = []
  readonly tracked = new Map<string, Tracked>()
  readonly output: string[] = []
  alive = false

  constructor(
    readonly dirs: { userData: string; dest: string },
    private extraEnv: Record<string, string> = {}
  ) {}

  /** `args` follow the app on its command line, as a link the OS hands over would. */
  async launch(extraEnv: Record<string, string> = {}, args: string[] = []): Promise<this> {
    Object.assign(this.extraEnv, extraEnv)
    let retries = 5
    while (true) {
      try {
        this.electronApp = await electron.launch({
          args: electronArgs(PROJECT_ROOT, args),
          env: {
            ...(process.env as Record<string, string>),
            PLEXO_USER_DATA: this.dirs.userData,
            PLEXO_E2E_HIDE_WINDOW: '1',
            PLEXO_E2E_BLOCK_BYTES: String(BLOCK),
            PLEXO_E2E_RETRY_BASE_MS: '20',
            PLEXO_E2E_STALL_MS: '1500',
            // A busy server gives up after its retries alone, as any other wrong answer does,
            // unless a test waits it out on purpose.
            PLEXO_E2E_SERVER_BUSY_MS: '1',
            // Off unless a test asks for it: a hedge is an extra request, and most tests count them.
            PLEXO_E2E_HEDGE_MS: '600000',
            // Fixed for the same reason, and for downloads started through the UI.
            PLEXO_E2E_STREAMS: '2',
            PLEXO_E2E_INTERFACES: interfacesEnv(NETWORKS),
            // Torrent tests find their peers from the link itself; a run never joins the real DHT.
            PLEXO_E2E_DHT: '0',
            ...this.extraEnv
          }
        })
        break
      } catch (e: unknown) {
        if (retries-- > 0 && e instanceof Error && e.message?.includes('ETXTBSY')) {
          await new Promise((resolve) => setTimeout(resolve, 100))
          continue
        }
        throw e
      }
    }
    const child = this.electronApp.process()
    child.stdout?.on('data', (data) => this.output.push(String(data)))
    child.stderr?.on('data', (data) => this.output.push(String(data)))
    this.alive = true

    this.page = await this.electronApp.firstWindow()
    await this.page.waitForLoadState('domcontentloaded')
    const session: DownloadState[] = []
    const updates: DownloadUpdate[] = []
    this.sessions.push(session)
    this.updates.push(updates)
    // Kept whole, the way the window puts them together: each download from its own last state.
    const latest = new Map<string, DownloadState>()
    await this.page.exposeFunction('__plexoRecord', (update: DownloadUpdate) => {
      updates.push(update)
      const previous = latest.get(update.state.id) ?? null
      const state = applyDownloadUpdate(previous, update)
      if (state && state !== previous) {
        latest.set(state.id, state)
        session.push(state)
      }
    })
    await this.page.evaluate(() => {
      const w = window as unknown as { __plexoRecord: (s: unknown) => void }
      window.plexo.onDownloadUpdated((update) => w.__plexoRecord(update))
    })
    return this
  }

  /** Kills the main process outright — no before-quit, no suspend: a crash or power cut. */
  async kill(): Promise<void> {
    const child = this.electronApp.process()
    if (child.exitCode !== null || child.signalCode !== null) {
      this.alive = false
      return
    }
    // Windows does not propagate killing the main process to Chromium's children. They retain
    // the profile lock and open databases, preventing both relaunch and fixture disposal.
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    if (process.platform === 'win32') {
      await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } else {
      child.kill('SIGKILL')
    }
    await closed
    this.alive = false
  }

  /** Normal quit — runs before-quit, which suspends (pauses and persists) the download. */
  async quit(): Promise<void> {
    await this.electronApp.close()
    this.alive = false
  }

  async relaunch(extraEnv: Record<string, string> = {}): Promise<this> {
    if (this.alive) await this.quit()
    return this.launch(extraEnv)
  }

  api: Api = new Proxy({} as Api, {
    get:
      (_target, name: string) =>
      (...args: unknown[]) =>
        this.page.evaluate(
          ([method, params]) =>
            (window.plexo as unknown as Record<string, (...a: unknown[]) => unknown>)[method](
              ...params
            ),
          [name, args] as const
        )
  })

  /** Main-process code, e.g. to replace a dialog or make a network disappear. */
  evaluateMain<R, A>(fn: (electron: typeof import('electron'), arg: A) => R, arg: A): Promise<R> {
    return this.electronApp.evaluate(fn as never, arg) as Promise<R>
  }

  /** Sets how many streams the next download runs per network (see StartOptions). */
  private async pinStreams(connections: number | 'auto' = 2): Promise<void> {
    await this.evaluateMain(
      (_electron, value) => {
        if (value === null) delete process.env.PLEXO_E2E_STREAMS
        else process.env.PLEXO_E2E_STREAMS = value
      },
      connections === 'auto' ? null : String(connections)
    )
  }

  /** Probes and starts `url` exactly the way IdleScreen's Start button does. */
  async start(url: string, expectedSha: string, options: StartOptions = {}): Promise<string> {
    await this.pinStreams(options.connections)
    await this.api.listInterfaces()
    const probe = await this.api.probeUrl(url)
    const multiChunk = probe.supportsRanges && probe.totalBytes !== null
    const networks = options.networks ?? ['a']
    const destinationDir = options.destinationDir ?? this.dirs.dest
    const destBefore = existsSync(destinationDir) ? await readdir(destinationDir) : []

    const common = {
      url: probe.finalUrl,
      destinationDir,
      suggestedFileName: options.fileName ?? probe.suggestedFileName,
      totalBytes: probe.totalBytes ?? 0,
      supportsRanges: multiChunk,
      interfaceIds: multiChunk ? networks : networks.slice(0, 1),
      etag: probe.etag,
      lastModified: probe.lastModified
    }
    const id = await this.api.startDownload(
      probe.kind === 'torrent'
        ? {
            ...common,
            kind: 'torrent',
            infoHash: probe.torrent.infoHash,
            selectedFiles: options.selectedFiles
          }
        : { ...common, kind: 'http', streamsPerNetwork: options.streamsPerNetwork }
    )
    this.tracked.set(id, { expectedSha, destBefore, destinationDir })
    return id
  }

  /** For downloads started through the UI rather than start(): declares what the next one
   * should produce, so the automatic checks can verify it. Call before clicking Start. */
  async expectNextDownload(expectedSha: string): Promise<void> {
    this.nextDownload = {
      expectedSha,
      destBefore: await readdir(this.dirs.dest),
      destinationDir: this.dirs.dest
    }
  }

  nextDownload: Tracked | null = null

  /** Opens New download as its button does, and gives its link field. */
  async newDownload(): Promise<Locator> {
    const link = this.page.getByRole('textbox', { name: 'Link' })
    if (!(await link.isVisible())) {
      await this.page.getByRole('button', { name: 'New download' }).first().click()
    }
    return link
  }

  /** Every download, running or finished, oldest first. A finished one comes from history, so it
   * has no work units left. */
  async all(): Promise<DownloadState[]> {
    const running = (await this.api.listDownloads()).map((snapshot) =>
      applyDownloadUpdate(null, snapshot)!
    )
    // As the window was last sent it, when this launch saw it finish: blocks and all.
    const seen = this.sessions.at(-1) ?? []
    const finished = (await this.api.listHistory()).map((entry): DownloadState => {
      const last = seen.findLast((state) => state.id === entry.id)
      if (last?.status === 'completed') return last
      return entry.kind === 'http'
        ? { ...entry, blocks: [], streams: [] }
        : { ...entry, pieces: [], peers: [] }
    })
    return [...running, ...finished].sort((a, b) => a.startedAt - b.startedAt)
  }

  /** The download started last. */
  async current(): Promise<DownloadState | null> {
    return (await this.all()).at(-1) ?? null
  }

  /** One download by id, wherever it is. */
  async byId(id: string): Promise<DownloadState | null> {
    return (await this.all()).find((state) => state.id === id) ?? null
  }

  async waitForStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<DownloadState> {
    const wanted = Array.isArray(status) ? status : [status]
    return this.waitUntil((state) => wanted.includes(state.status), timeout)
  }

  async waitForHttpStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<HttpDownloadState> {
    return expectHttp(await this.waitForStatus(status, timeout))
  }

  async waitForTorrentStatus(
    status: DownloadStatus | DownloadStatus[],
    timeout = 20_000
  ): Promise<TorrentDownloadState> {
    return expectTorrent(await this.waitForStatus(status, timeout))
  }

  async currentHttp(): Promise<HttpDownloadState | null> {
    const state = await this.current()
    return state ? expectHttp(state) : null
  }

  async currentTorrent(): Promise<TorrentDownloadState | null> {
    const state = await this.current()
    return state ? expectTorrent(state) : null
  }

  /** Waits until the download state matches `predicate`. A timeout says what the state was
   * instead, so a hang shows the last progress and state. */
  async waitUntil(
    predicate: (state: DownloadState) => boolean,
    timeout = 20_000
  ): Promise<DownloadState> {
    const deadline = Date.now() + timeout
    let state: DownloadState | null = null
    while (Date.now() < deadline) {
      state = await this.current()
      if (state && predicate(state)) return state
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const networks = state?.networks.map(
      (network) => `${network.id}:${network.status}${network.error ? ` (${network.error})` : ''}`
    )
    const connections = state
      ? (state.kind === 'http' ? state.streams : state.peers).map(
          (connection) => `${connection.interfaceId}:${connection.status}`
        )
      : undefined
    throw new Error(
      `Timed out after ${timeout} ms waiting on the download. Last seen: ${
        state
          ? `status=${state.status}${state.error ? `, error="${state.error}"` : ''}, bytes=${state.bytesDownloaded}/${state.totalBytes}, networks=[${networks?.join(', ')}], connections=[${connections?.join(', ')}]`
          : 'no current download'
      }`
    )
  }
}

// --- invariants --------------------------------------------------------------------------------

const ALLOWED_NEXT: Record<DownloadStatus, DownloadStatus[]> = {
  queued: ['queued', 'downloading', 'paused', 'cancelled'],
  downloading: ['downloading', 'paused', 'completed', 'error', 'cancelled'],
  // Resumed: at once, or into the queue when it's full.
  paused: ['paused', 'downloading', 'queued', 'error', 'cancelled'],
  completed: ['completed'],
  // Resumed, or removed by the user.
  error: ['error', 'downloading', 'queued', 'cancelled'],
  cancelled: ['cancelled']
}

/** Rules every download event must satisfy, whatever the scenario. Node assertions keep this
 * exhaustive scan synchronous without creating a report step for every block of every event.
 * Failures still carry the download, status and work-unit context. */
export function checkEvents(sessions: DownloadState[][]): void {
  for (const events of sessions) {
    const lastStatus = new Map<string, DownloadStatus>()
    for (const state of events) {
      const label = `${state.id} @ ${state.status}`
      if (state.totalBytes > 0) {
        assert.ok(
          state.bytesDownloaded <= state.totalBytes,
          `${label}: bytesDownloaded ≤ totalBytes`
        )
      }
      const units = state.kind === 'http' ? state.blocks : state.pieces
      assert.equal(
        units.every((unit, index) => unit.index === index),
        true,
        `${label}: every work unit is there, in order`
      )
      assert.equal(
        units.length,
        state.kind === 'http' ? state.totalBlocks : state.totalPieces,
        `${label}: as many work units as planned`
      )
      for (const unit of units) {
        const attributed = Object.values(unit.bytesByInterface).reduce((a, b) => a + b, 0)
        assert.equal(
          attributed,
          unit.bytesDownloaded,
          `${label}: unit ${unit.index} attribution sums to its bytes`
        )
        if (unit.rangeEnd !== null) {
          const size = unit.rangeEnd - unit.rangeStart + 1
          assert.ok(unit.bytesDownloaded <= size, `${label}: unit ${unit.index} within its size`)
          if (unit.status === 'completed') {
            assert.equal(
              unit.bytesDownloaded,
              size,
              `${label}: completed unit ${unit.index} is full`
            )
          }
        }
        if (unit.kind === 'torrent') {
          assert.ok(unit.provisionalBytes >= 0)
          assert.ok(
            unit.provisionalBytes <=
              (unit.rangeEnd === null ? 0 : unit.rangeEnd - unit.rangeStart + 1)
          )
        }
      }
      if (state.kind === 'torrent') {
        assert.equal(
          new Set(state.peers.map((peer) => peer.id)).size,
          state.peers.length,
          `${label}: peer IDs are unique across networks`
        )
        // Peers are connections, not piece owners. Each belongs to one known network and exposes
        // only transfer telemetry; verified progress belongs to pieces above.
        for (const peer of state.peers) {
          assert.ok(
            state.networks.map((network) => network.id).includes(peer.interfaceId),
            `${label}: peer ${peer.id} is on a network of this download`
          )
          assert.ok(['connected', 'receiving'].includes(peer.status))
        }
        const uploaded = state.networks.reduce((sum, network) => sum + network.bytesUploaded, 0)
        assert.equal(
          uploaded,
          state.bytesUploaded,
          `${label}: the networks' uploads add up to the download's`
        )
      } else if (state.status === 'downloading') {
        // A stream holds a block exactly while it is fetching it. A block has at most one stream
        // fetching it for real and two racing it as hedges, and is in flight whenever the first
        // is there. What the stream rows show is only as true as this.
        const primaries = new Map<number, number>()
        const hedges = new Map<number, number>()
        for (const stream of state.streams) {
          const holding = stream.currentBlockIndex !== undefined
          assert.equal(
            holding,
            stream.status === 'downloading',
            `${label}: stream ${stream.id} (${stream.status}) holds a block`
          )
          if (stream.currentBlockIndex === undefined) {
            assert.ok(!stream.hedge, `${label}: idle stream ${stream.id} is not racing`)
            continue
          }
          const tally = stream.hedge ? hedges : primaries
          tally.set(stream.currentBlockIndex, (tally.get(stream.currentBlockIndex) ?? 0) + 1)
        }
        for (const [index, count] of primaries) {
          assert.equal(count, 1, `${label}: block ${index} has one stream fetching it`)
        }
        for (const [index, count] of hedges) {
          assert.ok(count <= 2, `${label}: block ${index} has at most two hedges`)
        }
        for (const index of primaries.keys()) {
          assert.equal(
            state.blocks[index]?.status,
            'downloading',
            `${label}: held block ${index} is in flight`
          )
        }
      }
      const previous = lastStatus.get(state.id)
      if (previous) {
        assert.ok(
          ALLOWED_NEXT[previous].includes(state.status),
          `${state.id}: ${previous} → ${state.status}`
        )
      }
      lastStatus.set(state.id, state.status)
    }
  }
}

/** A folder's files as one hash: each file's path (relative, with `/`) and the SHA-256 of its
 * bytes, in path order. What a multi-file torrent's download is checked against. */
export function treeSha(files: { path: string; data: Buffer }[]): string {
  const lines = files
    .map((file) => `${file.path}\0${sha256(file.data)}\n`)
    .sort()
    .join('')
  return sha256(Buffer.from(lines))
}

/** sha256 of a file, or treeSha of a folder. */
export async function shaOfPath(path: string): Promise<string> {
  if (!(await stat(path)).isDirectory()) return sha256(await readFile(path))
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const full = join(entry.parentPath, entry.name)
        return { path: relative(path, full).split(sep).join('/'), data: await readFile(full) }
      })
  )
  return treeSha(files)
}

async function openFilesUnder(pid: number, roots: string[]): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-Fn', '-p', String(pid)])
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => line.slice(1))
      .filter((path) => roots.some((root) => path.startsWith(root)))
  } catch {
    return [] // lsof missing — skip this check rather than fail on it
  }
}

/**
 * The end-of-test rules: once a download has finished (either way), what's on disk must be
 * exactly right. The one that matters most: `completed` never means wrong bytes.
 */
export async function checkFinalState(app: PlexoApp): Promise<void> {
  const states = await app.all()
  const latest = states.at(-1)
  const checked = states.flatMap((state) => {
    const tracked = app.tracked.get(state.id) ?? (state === latest ? app.nextDownload : null)
    return tracked ? [{ state, tracked }] : []
  })
  // Any still under way: there's no final state to check yet.
  const terminal = (status: DownloadStatus): boolean =>
    ['completed', 'error', 'cancelled'].includes(status)
  if (checked.length === 0 || !checked.every(({ state }) => terminal(state.status))) return

  for (const { state, tracked } of checked) {
    // A failed download keeps its progress to be resumed until the user moves on, as the
    // window's New Download does: after that, nothing may be left.
    if (state.status === 'error') await app.api.removeDownload(state.id)

    if (state.status === 'completed') {
      expect(await shaOfPath(state.destinationPath), 'completed download matches its source').toBe(
        tracked.expectedSha
      )
    } else {
      expect(existsSync(state.destinationPath), 'no file left at the destination').toBe(false)
    }

    const stagingPath = `${state.destinationPath}.plexo`
    await expect
      .poll(() => existsSync(stagingPath), { message: 'staging file cleaned up', timeout: 5000 })
      .toBe(false)
  }

  // Each folder gains exactly the downloads that completed into it, and nothing else.
  for (const destinationDir of new Set(checked.map(({ tracked }) => tracked.destinationDir))) {
    const into = checked.filter(({ tracked }) => tracked.destinationDir === destinationDir)
    // As the folder was before the first of them started (later ones saw the earlier ones' files).
    const before = new Set(into[0].tracked.destBefore)
    const destAfter = existsSync(destinationDir) ? await readdir(destinationDir) : []
    const added = destAfter.filter((name) => !before.has(name)).sort()
    const expectedAdded = into
      .filter(({ state }) => state.status === 'completed')
      .map(({ state }) => state.destinationPath.split(/[\\/]/).pop())
      .sort()
    expect(added, 'no stray files (placeholders, partials) in the destination folder').toEqual(
      expectedAdded
    )
  }

  const pid = app.electronApp.process().pid
  if (pid) {
    await expect
      .poll(() => openFilesUnder(pid, [app.dirs.dest, join(app.dirs.userData, 'downloads')]), {
        message: 'no file handles left open on download files',
        timeout: 5000
      })
      .toEqual([])
  }
}

// --- fixtures ----------------------------------------------------------------------------------

/** A fresh userData + destination folder pair under the OS temp directory. */
export async function makeDirs(): Promise<{
  dirs: { userData: string; dest: string }
  dispose: () => Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plexo-e2e-')))
  const dirs = { userData: join(root, 'userData'), dest: join(root, 'dest') }
  await Promise.all([mkdir(dirs.userData), mkdir(dirs.dest)])
  return { dirs, dispose: () => rm(root, { recursive: true, force: true, maxRetries: 5 }) }
}

interface Fixtures {
  /** Extra environment for the app, e.g. `test.use({ appEnv: { PLEXO_E2E_RETRY_BASE_MS: '2000' } })`. */
  appEnv: Record<string, string>
  dirs: { userData: string; dest: string }
  /** Starts a test server; every one started is stopped after the test. */
  serve: (options: OriginOptions) => Promise<Origin>
  plexo: PlexoApp
  checks: void
}

export const test = base.extend<Fixtures>({
  appEnv: [{}, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  dirs: async ({}, use) => {
    const { dirs, dispose } = await makeDirs()
    await use(dirs)
    await dispose()
  },

  // eslint-disable-next-line no-empty-pattern
  serve: async ({}, use, testInfo) => {
    const origins: Origin[] = []
    await use(async (options) => {
      const origin = await new Origin(options).start()
      origins.push(origin)
      return origin
    })
    if (testInfo.status !== testInfo.expectedStatus) {
      const log = origins.map((origin) => origin.log)
      await testInfo.attach('server-requests.json', { body: JSON.stringify(log, null, 2) })
    }
    await Promise.all(origins.map((origin) => origin.stop()))
  },

  plexo: async ({ dirs, appEnv }, use, testInfo) => {
    const app = new PlexoApp(dirs, { ...appEnv })
    await app.launch()
    await use(app)
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('download-events.json', {
        body: JSON.stringify(app.sessions, null, 2)
      })
      await testInfo.attach('app-output.txt', { body: app.output.join('') })
    }
    if (app.alive) await app.electronApp.close().catch(() => {})
  },

  checks: [
    async ({ plexo }, use, testInfo) => {
      await use()
      // A test already failing (or expected to fail) has said what it needed to.
      if (testInfo.status !== 'passed' || testInfo.expectedStatus !== 'passed') return
      checkEvents(plexo.sessions)
      // Listeners piling up on one stream or emitter: harmless today, a leak tomorrow.
      expect(plexo.output.join(''), 'the app warned of a listener leak').not.toContain(
        'MaxListenersExceededWarning'
      )
      if (plexo.alive) await checkFinalState(plexo)
    },
    { auto: true }
  ]
})
