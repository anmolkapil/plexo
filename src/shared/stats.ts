/**
 * Anonymous usage and error stats: the complete list of what Plexo may send (see
 * docs/privacy/index.html, which lists the same events). The app builds every event from this
 * list and checks it before queuing it, and stats-worker/ checks it again and drops anything that
 * doesn't match, so nothing outside it can be stored. Every value is a short string from a fixed
 * set or a fixed shape: never a link, a host, a file or folder name, an address or free text.
 */

/** The privacy page: what the stats contain, event by event (docs/privacy/index.html). */
export const PRIVACY_URL = 'https://getplexo.app/privacy/'

export const NETWORK_KINDS = ['wifi', 'ethernet', 'usb', 'bridge', 'other'] as const
export const DOWNLOAD_TYPES = ['http', 'torrent', 'nzb', 'telegram'] as const

export const SIZE_BUCKETS = ['0', '<10MB', '10-100MB', '100MB-1GB', '1-10GB', '>10GB'] as const
export const DURATION_BUCKETS = ['<10s', '10s-1m', '1-10m', '10-60m', '1-6h', '>6h'] as const
export const SPEED_BUCKETS = [
  '<1MB/s',
  '1-5MB/s',
  '5-20MB/s',
  '20-50MB/s',
  '50-100MB/s',
  '>100MB/s'
] as const

const kinds = NETWORK_KINDS.join('|')

/** What a field's value may be: one of a list, or a string of a fixed shape. */
type FieldRule = readonly string[] | RegExp

const FIELDS = {
  type: DOWNLOAD_TYPES,
  size: SIZE_BUCKETS,
  done: SIZE_BUCKETS,
  duration: DURATION_BUCKETS,
  speed: SPEED_BUCKETS,
  /** The kind of each network that delivered part of the file, sorted, e.g. `usb,wifi,wifi`. */
  networks: new RegExp(`^(none|(${kinds})(,(${kinds})){0,7})$`),
  /** How many networks of each kind the computer has, e.g. `ethernet:1,usb:1,wifi:1`. */
  network_count: new RegExp(`^(none|(${kinds}):\\d{1,2}(,(${kinds}):\\d{1,2}){0,4})$`),
  extension: ['yes', 'no'],
  auto_update: ['yes', 'no'],
  /** A code from errorClass() in errors.ts: never the error's own text. */
  error_class: /^[a-z][a-z0-9_]{0,31}$/,
  /** The status code of the server's last refusal, a number only. */
  http_status: /^(|[1-5]\d\d)$/,
  process: /^[a-z][a-z-]{0,23}$/,
  /** The error's type, e.g. TypeError. */
  name: /^[A-Za-z][A-Za-z0-9]{0,39}$/,
  /** Up to five frames from Plexo's own bundled code, file and line only: `index.js:120;…`. */
  frames: /^(|[\w-]{1,40}\.m?js:\d{1,7}(;[\w-]{1,40}\.m?js:\d{1,7}){0,4})$/,
  reason: /^[a-z][a-z-]{0,31}$/,
  exit_code: /^-?\d{1,10}$/
} as const satisfies Record<string, FieldRule>

export type StatsField = keyof typeof FIELDS

/** Each event and its fields, in the order stats-worker/ stores them. */
export const STATS_EVENTS = {
  app_start: ['network_count', 'extension', 'auto_update'],
  download_finished: ['type', 'size', 'duration', 'speed', 'networks'],
  download_failed: ['type', 'error_class', 'http_status', 'done', 'networks'],
  app_error: ['process', 'name', 'error_class', 'frames'],
  process_gone: ['process', 'reason', 'exit_code'],
  update_failed: ['error_class']
} as const satisfies Record<string, readonly StatsField[]>

export type StatsEventName = keyof typeof STATS_EVENTS

export type StatsEvent = {
  [Name in StatsEventName]: {
    name: Name
    props: Record<(typeof STATS_EVENTS)[Name][number], string>
  }
}[StatsEventName]

/** What every batch carries once, for all of its events. */
export interface StatsBatch {
  /** A random id made for these stats alone; turning them off deletes it. */
  install_id: string
  app_version: string
  os: string
  /** The major version only. */
  os_version: string
  arch: string
  /** The UI language Plexo would use, e.g. `zh-CN`. */
  lang: string
  events: StatsEvent[]
}

export const MAX_EVENTS_PER_BATCH = 100

const BATCH_FIELDS: Record<Exclude<keyof StatsBatch, 'events'>, RegExp> = {
  install_id: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  app_version: /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,20})?$/,
  os: /^(win32|darwin|linux)$/,
  os_version: /^\d{1,5}$/,
  arch: /^(x64|arm64|ia32|arm)$/,
  lang: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/
}

function fieldValid(field: StatsField, value: unknown): boolean {
  if (typeof value !== 'string') return false
  const rule: FieldRule = FIELDS[field]
  return rule instanceof RegExp ? rule.test(value) : rule.includes(value)
}

/** Whether `event` is on the list with exactly its fields, each valid. */
export function validStatsEvent(event: unknown): event is StatsEvent {
  if (typeof event !== 'object' || event === null) return false
  const { name, props } = event as { name?: unknown; props?: unknown }
  if (typeof name !== 'string' || !Object.hasOwn(STATS_EVENTS, name)) return false
  if (typeof props !== 'object' || props === null) return false
  const fields: readonly StatsField[] = STATS_EVENTS[name as StatsEventName]
  const keys = Object.keys(props)
  return (
    keys.length === fields.length &&
    fields.every((field) => fieldValid(field, (props as Record<string, unknown>)[field]))
  )
}

/** Whether the batch's own fields are valid (its events are checked one by one). */
export function validStatsBatch(batch: unknown): batch is StatsBatch {
  if (typeof batch !== 'object' || batch === null) return false
  const record = batch as Record<string, unknown>
  return (
    Array.isArray(record.events) &&
    record.events.length <= MAX_EVENTS_PER_BATCH &&
    (Object.keys(BATCH_FIELDS) as (keyof typeof BATCH_FIELDS)[]).every(
      (key) => typeof record[key] === 'string' && BATCH_FIELDS[key].test(record[key] as string)
    )
  )
}

const MB = 1024 * 1024

export function sizeBucket(bytes: number): (typeof SIZE_BUCKETS)[number] {
  if (!(bytes > 0)) return '0'
  if (bytes < 10 * MB) return '<10MB'
  if (bytes < 100 * MB) return '10-100MB'
  if (bytes < 1024 * MB) return '100MB-1GB'
  if (bytes < 10 * 1024 * MB) return '1-10GB'
  return '>10GB'
}

export function durationBucket(ms: number): (typeof DURATION_BUCKETS)[number] {
  const minutes = ms / 60_000
  if (!(ms >= 10_000)) return '<10s'
  if (minutes < 1) return '10s-1m'
  if (minutes < 10) return '1-10m'
  if (minutes < 60) return '10-60m'
  if (minutes < 360) return '1-6h'
  return '>6h'
}

export function speedBucket(bytesPerSec: number): (typeof SPEED_BUCKETS)[number] {
  const mbps = bytesPerSec / MB
  if (!(mbps >= 1)) return '<1MB/s'
  if (mbps < 5) return '1-5MB/s'
  if (mbps < 20) return '5-20MB/s'
  if (mbps < 50) return '20-50MB/s'
  if (mbps < 100) return '50-100MB/s'
  return '>100MB/s'
}

/** The networks that delivered part of a file, by kind only, e.g. `usb,wifi,wifi`. */
export function networkKinds(
  networks: readonly { kind: string; bytesDownloaded: number }[]
): string {
  const used = networks
    .filter((network) => network.bytesDownloaded > 0)
    .map((network) =>
      (NETWORK_KINDS as readonly string[]).includes(network.kind) ? network.kind : 'other'
    )
    .sort()
    .slice(0, 8)
  return used.length > 0 ? used.join(',') : 'none'
}

/** How many networks of each kind there are, e.g. `ethernet:1,wifi:1`. */
export function networkCount(networks: readonly { kind: string }[]): string {
  const counts = new Map<string, number>()
  for (const network of networks) {
    const kind = (NETWORK_KINDS as readonly string[]).includes(network.kind)
      ? network.kind
      : 'other'
    counts.set(kind, Math.min((counts.get(kind) ?? 0) + 1, 99))
  }
  if (counts.size === 0) return 'none'
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(',')
}

/** The frames of a stack trace that are in Plexo's own bundled code (out/main, out/preload,
 * out/renderer, inside app.asar once packaged), as `file.js:line`, at most five. Everything else
 * about a frame — the folder Plexo is installed in, which can hold the user's name, the column,
 * the function — is left out, and frames from anywhere else are skipped. */
export function stackFrames(stack: string | undefined): string {
  if (!stack) return ''
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const match =
      /[\\/]out[\\/](?:main|preload|renderer)[\\/](?:[^\\/:()\s]+[\\/])*([\w-]{1,40}\.m?js):(\d{1,7}):\d+/.exec(
        line
      )
    if (match) frames.push(`${match[1]}:${match[2]}`)
    if (frames.length === 5) break
  }
  return frames.join(';')
}
