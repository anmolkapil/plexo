import type { DownloadState, NetworkInterfaceKind, NetworkStatus } from './types'

export interface ReportEnvironment {
  appVersion: string
  os: string
  architecture: string
}

/**
 * Reports use a strict allowlist of data, not redaction of raw errors: error strings can contain
 * signed URLs, usernames, paths, hostnames or tokens in an unknown format. Never add raw values
 * from download.url, error, network.error, fileName, label, ids or torrent peers.
 */
const KINDS: readonly NetworkInterfaceKind[] = ['wifi', 'usb', 'ethernet', 'bridge', 'other']
const STATES: readonly NetworkStatus[] = ['on', 'off', 'offline', 'unreachable', 'failed', 'limit']
const MIB = 1024 ** 2

function safeBuild(value: string): string {
  return /^[A-Za-z0-9._+-]{1,40}$/.test(value) ? value : 'unknown'
}

function sizeBucket(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown'
  if (bytes < MIB) return 'under 1 MiB'
  if (bytes < 10 * MIB) return '1–10 MiB'
  if (bytes < 100 * MIB) return '10–100 MiB'
  if (bytes < 1024 * MIB) return '100 MiB–1 GiB'
  if (bytes < 10 * 1024 * MIB) return '1–10 GiB'
  return 'over 10 GiB'
}

function failureKind(error: string | undefined): string {
  if (!error) return 'Unknown failure'
  // Numeric status is deliberately extracted without copying the surrounding untrusted text.
  const status = /\b(?:status|http)\s+([1-5]\d{2})\b/i.exec(error)
  if (status) return `HTTP ${status[1]}`
  if (/certificate|self.signed|\btls\b|\bssl\b/i.test(error)) return 'TLS verification'
  if (/\bENOSPC\b|not enough (?:disk )?space|disk is full/i.test(error))
    return 'Insufficient disk space'
  if (/\bETIMEDOUT\b|timed? out|timeout/i.test(error)) return 'Timeout'
  if (/\bECONNREFUSED\b|connection refused/i.test(error)) return 'Connection refused'
  if (/\bENOTFOUND\b|\bEAI_AGAIN\b|could not resolve/i.test(error)) return 'DNS'
  if (/\bECONNRESET\b|socket hang up/i.test(error)) return 'Connection reset'
  if (/changed on the server|different file|file changed/i.test(error)) return 'Remote file changed'
  return 'Other failure (details withheld)'
}

function booleanFlag(flag: boolean | undefined): string {
  return flag === undefined ? 'unknown' : flag ? 'yes' : 'no'
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 99999) : 0
}

export function createFailureReport(download: DownloadState, env: ReportEnvironment): string {
  const kinds = KINDS.map((kind) => `${kind}: ${count(download.networks.filter((n) => n.kind === kind).length)}`)
  const states = STATES.map(
    (state) => `${state}: ${count(download.networks.filter((n) => n.status === state).length)}`
  )
  const result = [
    'Plexo failure report (user-generated; no automatic telemetry)',
    `Plexo version: ${safeBuild(env.appVersion)}`,
    `OS: ${safeBuild(env.os)}`,
    `Architecture: ${safeBuild(env.architecture)}`,
    `Download type: ${download.kind === 'http' ? 'HTTP' : 'Torrent'}`,
    `Failure: ${failureKind(download.error)}`,
    `Size: ${sizeBucket(download.totalBytes)}`,
    `Networks: ${count(download.networks.length)} (${kinds.join(', ')})`,
    `Network states: ${states.join(', ')}`,
    `Retries: ${count(download.networks.reduce((sum, network) => sum + count(network.retries), 0))}`
  ]
  if (download.kind === 'http') {
    const statuses = (download.recentHttpStatuses ?? [])
      .filter((code) => Number.isInteger(code) && code >= 100 && code <= 599)
      .slice(-5)
    result.push(
      `Recent failed HTTP statuses: ${statuses.length ? statuses.join(', ') : 'not recorded'}`,
      `Range support: ${booleanFlag(download.supportsRanges)}`,
      `ETag present: ${booleanFlag(download.etagPresent)}`,
      `Last-Modified present: ${booleanFlag(download.lastModifiedPresent)}`,
      `Streams at failure: ${count(download.streams.length)}`,
      `Peak streams: ${count(download.peakStreams)}`
    )
  } else {
    result.push(
      `Peers at failure: ${count(download.peers.length)}`,
      `Peak peers: ${count(download.peakPeers)}`,
      'Wire count: not recorded'
    )
  }
  result.push(
    'Excluded: links, hosts, filenames, paths, IPs, cookies, device names, torrent hashes and exact sizes.'
  )
  return result.join('\n')
}

/** The OS opens a draft; only clicking Submit in GitHub actually publishes it. */
export function githubFailureReportUrl(report: string): string {
  const url = new URL('https://github.com/anmolkapil/plexo/issues/new')
  url.searchParams.set('title', 'Download failure report')
  url.searchParams.set(
    'body',
    `## Download failure\n\n\`\`\`text\n${report}\n\`\`\`\n\nDescribe what happened and review the details before submitting.\n`
  )
  return url.toString()
}
