import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Event, StackFrame } from '@sentry/electron/main'
import { IpcChannels } from '../shared/ipc-channels'
import type { InitialState } from '../shared/types'

declare const __PLEXO_SENTRY_DSN__: string

const operations = [
  'unhandled',
  'restore',
  'checkpoint',
  'transfer',
  'network',
  'publish',
  'repair',
  'unpack',
  'updater',
  'preload',
  'bridge',
  'preferences',
  'telegram'
] as const
type Operation = (typeof operations)[number] | keyof typeof IpcChannels

// These expressions only select constant codes. No part of a message, URL or path becomes a tag.
const knownFailures = {
  no_space: /ENOSPC|EDQUOT|(?:not|isn’t) enough (?:disk )?space/i,
  dns: /ENOTFOUND|EAI_AGAIN|resolve the download host in time/i,
  access_denied: /EACCES|EPERM/,
  file_missing: /ENOENT|partial download file is (?:missing|unavailable)/,
  read_only: /EROFS/,
  disk_io: /\bEIO\b/,
  connection_refused: /ECONNREFUSED/,
  connection_reset: /ECONNRESET|EPIPE|socket hang up|connection to Telegram dropped/i,
  network_unreachable: /ENETUNREACH|EHOSTUNREACH|address compatible with|network unreachable/i,
  timeout: /TIMEDOUT|timed out|connection stalled/i,
  tls: /certificate|SSL routines|secure TLS connection/i,
  news_server_refused: /news server answered (?:4|5)\d\d/i,
  authentication:
    /authentication|username or password|session signed out|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|PASSWORD_HASH_INVALID|PHONE_CODE_INVALID/i,
  rate_limit: /FLOOD_WAIT|Telegram rate limit/i,
  usenet_configuration: /set up a news server|Usenet is switched off/i,
  missing_media: /media is gone|FILE_ID_INVALID|MESSAGE_ID_INVALID/i,
  redirects: /too many redirects/i,
  proxy_connection: /proxy CONNECT failed|SOCKS[45] connection/i,
  input_invalid: /Invalid URL|Invalid magnet|Invalid torrent|Select at least one network/i,
  archive_password: /password-protected/,
  unpack_failed: /couldn’t unpack/i,
  repair_failed: /par2.*repair|\.par2 files can repair/i,
  tool_missing: /^Install (?:par2|7-Zip)/,
  articles_missing: /none of this NZB’s articles|articles? (?:wasn’t|weren’t) on the news server/,
  unclean_exit: /^Main process ended unexpectedly$/,
  file_changed: /changed (?:on the server|during the download)|link is to a different file/i
} as const

function failureCode(message: string): string | undefined {
  const http = /(?:status(?: code)?|HTTP)[ :]+([45]\d\d)\b/i.exec(message)
  if (http) return 'http_' + http[1]
  return Object.entries(knownFailures).find(([, pattern]) => pattern.test(message))?.[0]
}

function configuredDsn(): string | undefined {
  if (app.isPackaged) return __PLEXO_SENTRY_DSN__ || undefined
  const port = process.env.PLEXO_E2E_SENTRY_PORT
  if (port && /^\d{1,5}$/.test(port) && Number(port) > 0 && Number(port) <= 65535) {
    return 'http://local@127.0.0.1:' + port + '/1'
  }
  return undefined
}

export function reportingAvailability(): InitialState['reportingAvailability'] {
  if (process.env.DO_NOT_TRACK === '1') return 'do-not-track'
  return configuredDsn() ? 'configured' : 'unconfigured'
}

type SDK = typeof import('@sentry/electron/main')
let sdk: SDK | undefined
let initializing: Promise<void> | undefined
let enabled = false
let enabledSince = 0

/** Limit stacks to JS files in this build. Sentry normalizes the app directory to app:///.
 * Function names, context lines, local variables and frames from outside the app are private. */
function bundleFiles(): Set<string> {
  const files = new Set<string>()
  for (const dir of ['main', 'preload', 'renderer/assets']) {
    for (const file of readdirSync(join(app.getAppPath(), 'out', dir))) {
      if (file.endsWith('.js')) files.add('app:///out/' + dir + '/' + file)
    }
  }
  return files
}

function cleanEvent(event: Event, files: Set<string>, release: string): Event {
  const exception = event.exception?.values?.at(-1)
  const raw = exception?.value || event.message || ''
  const exit =
    /^'([^']+)' process exited with '(crashed|oom|abnormal-exit|launch-failed|integrity-failure|killed)'$/.exec(
      raw
    )
  const classification = event.tags?.failureCode
  const code = exit
    ? 'process_' + exit[2]
    : typeof classification === 'string' &&
        (Object.hasOwn(knownFailures, classification) || /^http_[45]\d\d$/.test(classification))
      ? classification
      : failureCode(raw)
  const originalOperation = event.tags?.operation
  const operation =
    typeof originalOperation === 'string' &&
    (Object.hasOwn(IpcChannels, originalOperation) ||
      operations.some((op) => op === originalOperation))
      ? originalOperation
      : 'unhandled'
  const role =
    operation === 'preload'
      ? 'preload'
      : event.tags?.['event.process'] === 'renderer' || exit?.[1] === 'renderer'
        ? 'renderer'
        : exit
          ? 'child'
          : 'main'
  const type =
    ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].find(
      (name) => name === exception?.type
    ) ?? 'Error'
  const frames: StackFrame[] = []
  if (!code) {
    for (const frame of exception?.stacktrace?.frames?.slice(-50) ?? []) {
      if (frame.filename && files.has(frame.filename) && Number.isSafeInteger(frame.lineno)) {
        frames.push({
          filename: frame.filename,
          lineno: frame.lineno,
          colno: Number.isSafeInteger(frame.colno) ? frame.colno : undefined,
          in_app: true
        })
      }
    }
  }
  const images = (event.debug_meta?.images ?? []).flatMap((image) =>
    image.type === 'sourcemap' &&
    frames.some((frame) => frame.filename === image.code_file) &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(image.debug_id)
      ? [{ type: 'sourcemap' as const, code_file: image.code_file, debug_id: image.debug_id }]
      : []
  )
  const handled = exception?.mechanism?.handled !== false && !exit
  return {
    event_id: randomUUID().replaceAll('-', ''),
    timestamp: Date.now() / 1000,
    release,
    environment: app.isPackaged ? 'production' : 'local-test',
    platform: 'javascript',
    sdk: {
      name: 'sentry.javascript.electron',
      version: sdk?.getClient()?.getSdkMetadata()?.sdk?.version,
      settings: { infer_ip: 'never' }
    },
    tags: {
      operation,
      process: role,
      os: process.platform,
      arch: process.arch,
      cause: code ?? 'unexpected'
    },
    level: exit
      ? event.level === 'warning'
        ? 'warning'
        : 'fatal'
      : code || operation === 'network'
        ? 'warning'
        : event.level === 'fatal'
          ? 'fatal'
          : 'error',
    fingerprint: code ? [code] : frames.length ? ['{{ default }}'] : [operation, role, type],
    exception: {
      values: [
        {
          type: code ?? type,
          value: code ?? 'Unexpected ' + type,
          mechanism: { type: 'generic', handled },
          ...(frames.length ? { stacktrace: { frames } } : {})
        }
      ]
    },
    ...(images.length ? { debug_meta: { images } } : {})
  }
}

async function initialize(dsn: string): Promise<void> {
  const sentry = await import('@sentry/electron/main')
  const files = bundleFiles()
  const release = 'plexo@' + app.getVersion()
  sentry.init({
    dsn,
    release,
    ipcMode: sentry.IPCMode.Classic,
    defaultIntegrations: false,
    integrations: [
      sentry.onUncaughtExceptionIntegration(),
      sentry.onUnhandledRejectionIntegration(),
      sentry.normalizePathsIntegration(),
      sentry.childProcessIntegration({
        breadcrumbs: false,
        events: ['abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']
      })
    ],
    sendClientReports: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false
    },
    tracePropagationTargets: [],
    maxBreadcrumbs: 0,
    // The SDK can forward non-error renderer envelopes without invoking beforeSend.
    // Filter at the actual transport boundary and construct both headers and payload afresh.
    transport: (options) => {
      const direct = sentry.makeElectronTransport(options)
      return {
        flush: direct.flush,
        send: (envelope) => {
          if (enabled && process.env.DO_NOT_TRACK !== '1') {
            for (const [header, payload] of envelope[1]) {
              if (header.type !== 'event') continue
              const input = payload as Event
              if (typeof input.timestamp !== 'number' || input.timestamp < enabledSince) continue
              const event = cleanEvent(input, files, release)
              return direct.send([
                { event_id: event.event_id!, sent_at: new Date().toISOString() },
                [[{ type: 'event' }, event]]
              ])
            }
          }
          return Promise.resolve({})
        }
      }
    }
  })
  sdk = sentry
}

/** Closing the gate is synchronous, including while a previous settings write is in flight. */
export async function setReporting(on: boolean): Promise<void> {
  const next = on && reportingAvailability() === 'configured'
  if (enabled === next && initializing) return initializing
  enabled = next
  if (enabled) enabledSince = Date.now() / 1000
  if (!enabled) clearRunMarker()
  if (enabled) {
    initializing ??= initialize(configuredDsn()!).catch(() => {
      enabled = false
      initializing = undefined
      console.error('[plexo] could not initialize error reporting')
    })
    await initializing
    if (enabled && sdk && !markedRunning) {
      // The main process cannot report its own abrupt death. A single empty marker can tell
      // the next consenting launch that it did not exit normally (including a forced quit).
      try {
        const path = markerPath()
        const interrupted = existsSync(path)
        writeFileSync(path, '')
        markedRunning = true
        if (interrupted) reportFailure('unhandled', new Error('Main process ended unexpectedly'))
      } catch {
        // A read-only profile must not prevent downloads or reporting.
      }
    }
  }
}

let markedRunning = false
const markerPath = (): string => join(app.getPath('userData'), 'reporting-run')
function clearRunMarker(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch {
    // Best effort during shutdown.
  }
  markedRunning = false
}

export function observeExit(): void {
  app.on('quit', (_event, code) => {
    if (code === 0 && markedRunning) clearRunMarker()
  })
  process.on('exit', (code) => {
    if (code === 0 && markedRunning) clearRunMarker()
  })
}

export function reportFailure(operation: Operation, cause: unknown): void {
  if (!enabled || !sdk) return
  const wrapper = cause instanceof Error ? cause : new Error(String(cause))
  const original = wrapper.cause instanceof Error ? wrapper.cause : wrapper
  const systemCode = (original as NodeJS.ErrnoException).code
  const code =
    failureCode(systemCode ?? '') ?? failureCode(original.message) ?? failureCode(wrapper.message)
  sdk.captureException(original, { tags: { operation, failureCode: code } })
}
