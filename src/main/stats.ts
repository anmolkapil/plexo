import { randomUUID } from 'node:crypto'
import { app, net } from 'electron'
import { errorClass, errorStatus } from '../shared/errors'
import {
  durationBucket,
  MAX_EVENTS_PER_BATCH,
  networkCount,
  networkKinds,
  sizeBucket,
  speedBucket,
  stackFrames,
  validStatsEvent,
  type StatsBatch,
  type StatsEvent
} from '../shared/stats'
import type {
  AppSettings,
  DownloadState,
  NetworkInterfaceInfo,
  StatsSettings
} from '../shared/types'
import { loadSettings, saveSettings } from './settings'
import { testKnobs } from './testKnobs'

/**
 * Anonymous usage and error stats, on unless turned off (Speed & data limits, or the notice that
 * tells people about them). Only what shared/stats.ts lists is sent — no links, file or folder
 * names, hosts or addresses — and docs/privacy/index.html says the same. Events are kept in
 * memory and sent every 15 minutes and on quit; offline, they're dropped.
 *
 * Nothing at all is sent:
 * - by a build made without PLEXO_STATS_URL (every development build), or in the e2e suite
 *   unless a test sets its own address;
 * - when DO_NOT_TRACK is set;
 * - before the notice about them has been read (OK, or a minute on screen), or once they're
 *   turned off.
 */

/** Set when a release is built (electron.vite.config.ts). */
declare const __PLEXO_STATS_URL__: string | undefined

/** Events a day per install, at most: a loop of errors can't send more. */
const DAILY_LIMIT = 200
/** Sending is never worth holding up a quit for. */
const SEND_TIMEOUT_MS = 2_500
/** Update checks fail like this whenever the computer is offline: no news. */
const OFFLINE_CLASSES = new Set(['dns', 'offline'])

let settings: AppSettings = {}
let queue: StatsEvent[] = []
let sentToday = { day: '', count: 0 }
let sending: Promise<void> | undefined
/** An error is reported once a session, however often it happens. */
const errorsSeen = new Set<string>()

function endpoint(): string | undefined {
  const doNotTrack = process.env['DO_NOT_TRACK']
  if (doNotTrack && doNotTrack !== '0') return undefined
  if (testKnobs.statsUrl) return testKnobs.statsUrl
  if (!app.isPackaged) return undefined
  return typeof __PLEXO_STATS_URL__ === 'string' && __PLEXO_STATS_URL__
    ? __PLEXO_STATS_URL__
    : undefined
}

/** Whether events are collected: they're kept until the notice has been read, then sent. */
function collecting(): boolean {
  return endpoint() !== undefined && settings.shareStats !== false
}

function sendable(): boolean {
  return collecting() && settings.statsNoticeShown === true
}

export function statsSettings(saved: AppSettings): StatsSettings {
  const available = endpoint() !== undefined
  const sharing = available && saved.shareStats !== false
  return { available, sharing, noticeDue: sharing && saved.statsNoticeShown !== true }
}

export async function startStats(): Promise<void> {
  settings = await loadSettings()
  if (endpoint() === undefined) return
  setInterval(() => void sendStats(), testKnobs.statsSendEveryMs).unref()
}

/** After any change to the settings. Turned off, what's queued goes (settings.ts has already
 * deleted the install id). */
export function statsSettingsChanged(saved: AppSettings): void {
  settings = saved
  if (!collecting()) queue = []
}

export async function statsNoticeShown(): Promise<void> {
  await saveSettings({ statsNoticeShown: true })
  settings = await loadSettings()
}

function record(event: StatsEvent): void {
  if (!collecting()) return
  if (!validStatsEvent(event)) {
    console.error('[plexo] stats: not on the list, dropped', (event as StatsEvent).name)
    return
  }
  if (queue.length < MAX_EVENTS_PER_BATCH) queue = [...queue, event]
}

/** Sends what's queued now (on a timer, and on quit). */
export function sendStats(): Promise<void> {
  sending ??= send().finally(() => {
    sending = undefined
  })
  return sending
}

async function send(): Promise<void> {
  const url = endpoint()
  if (!url || !sendable() || queue.length === 0) return
  const day = new Date().toISOString().slice(0, 10)
  if (sentToday.day !== day) sentToday = { day, count: 0 }
  // Past today's limit, the rest is dropped rather than kept for tomorrow.
  const events = queue.slice(0, Math.max(0, DAILY_LIMIT - sentToday.count))
  queue = []
  if (events.length === 0) return
  sentToday = { day, count: sentToday.count + events.length }

  const installId = await ensureInstallId()
  // Turned off while the id was being saved.
  if (!installId || !sendable()) return
  const batch: StatsBatch = {
    install_id: installId,
    app_version: app.getVersion(),
    os: process.platform,
    os_version: osVersion(),
    arch: process.arch,
    lang: language(),
    events
  }
  try {
    await net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
  } catch {
    // Offline or blocked: these are dropped, never retried or saved.
  }
}

async function ensureInstallId(): Promise<string | undefined> {
  if (settings.statsInstallId) return settings.statsInstallId
  try {
    await saveSettings({ statsInstallId: randomUUID() })
    settings = await loadSettings()
  } catch (error) {
    console.error('[plexo] stats: failed to save the install id', error)
  }
  return settings.statsInstallId
}

/** The major version only. Windows 11 still reports 10.0, with a build from 22000 up. */
function osVersion(): string {
  const [major = '0', , build = '0'] = process.getSystemVersion().split('.')
  if (process.platform === 'win32' && major === '10' && Number(build) >= 22000) return '11'
  return /^\d{1,5}$/.test(major) ? major : '0'
}

function language(): string {
  const locale = app.getLocale()
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(locale)) return locale
  const base = locale.split(/[-_]/)[0].toLowerCase()
  return /^[a-z]{2,3}$/.test(base) ? base : 'und'
}

function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : 'Error'
}

function processName(type: string): string {
  const name = type.toLowerCase().replace(/[^a-z]+/g, '-')
  return /^[a-z][a-z-]{0,23}$/.test(name) ? name : 'other'
}

export function appStarted(networks: readonly NetworkInterfaceInfo[]): void {
  record({
    name: 'app_start',
    props: {
      network_count: networkCount(networks),
      extension: settings.browserExtensionUsed ? 'yes' : 'no',
      auto_update: settings.autoUpdate === false ? 'no' : 'yes'
    }
  })
}

export function downloadFinished(state: DownloadState): void {
  const ms = (state.completedAt ?? Date.now()) - state.startedAt - (state.totalPausedMs ?? 0)
  record({
    name: 'download_finished',
    props: {
      type: state.kind,
      size: sizeBucket(state.bytesDownloaded),
      duration: durationBucket(ms),
      speed: speedBucket(ms > 0 ? state.bytesDownloaded / (ms / 1000) : 0),
      networks: networkKinds(state.networks)
    }
  })
}

export function downloadFailed(state: DownloadState): void {
  record({
    name: 'download_failed',
    props: {
      type: state.kind,
      error_class: errorClass(state.error ?? ''),
      http_status: errorStatus(state.error),
      done: sizeBucket(state.bytesDownloaded),
      networks: networkKinds(state.networks)
    }
  })
}

/** An error nothing caught, in main or (reported over IPC) in the window. Its message is never
 * sent: only its type, its errorClass, and where in Plexo's own code it was thrown. */
export function errorCaught(process: 'main' | 'renderer', error: unknown): void {
  const name = errorName(error)
  const frames = stackFrames(error instanceof Error ? error.stack : undefined)
  const key = `${process} ${name} ${frames}`
  if (errorsSeen.has(key)) return
  errorsSeen.add(key)
  record({
    name: 'app_error',
    props: { process, name, error_class: errorClass(error), frames }
  })
}

export function processGone(type: string, reason: string, exitCode: number): void {
  if (reason === 'clean-exit') return
  record({
    name: 'process_gone',
    props: {
      process: processName(type),
      reason: processName(reason),
      exit_code: String(Math.trunc(exitCode) || 0)
    }
  })
}

export function updateFailed(error: unknown): void {
  const code = errorClass(error)
  if (OFFLINE_CLASSES.has(code)) return
  record({ name: 'update_failed', props: { error_class: code } })
}
