import { expect, test } from '@playwright/test'
import { createFailureReport, githubFailureReportUrl } from '../src/shared/failureReport'
import type { DownloadState } from '../src/shared/types'

// These deliberately contain secrets in every string-shaped field a download can carry.
// Only numbers and approved enum labels may reach the report.
const secret = 'https://secret.example.test/file?token=api-secret-9283'
const network = {
  transfer: 'http' as const,
  id: '192.168.2.4',
  label: 'Secret USB Router',
  kind: 'usb' as const,
  enabled: true,
  status: 'failed' as const,
  error: `Status 403 from ${secret}; Authorization: Bearer secret`,
  retries: 8,
  bytesDownloaded: 3,
  speedBytesPerSec: 0
}
const state = {
  id: 'private-download-uuid',
  kind: 'http',
  url: secret,
  destinationPath: '/Users/alice/secret/movie.mkv',
  fileName: 'movie-secret.mkv',
  totalBytes: 800 * 1024 ** 2,
  bytesDownloaded: 23456,
  status: 'error',
  error: `Unexpected status 403 for range request at ${secret}; cookie=session-secret`,
  networks: [network],
  streams: [],
  peakStreams: 4,
  blocks: [],
  totalBlocks: 3,
  blockSizeBytes: 1024,
  supportsRanges: true,
  etagPresent: true,
  lastModifiedPresent: false,
  recentHttpStatuses: [403, 403, 429],
  startedAt: 0
} satisfies DownloadState

const environment = { appVersion: '1.0.0-rc.15', os: 'win32', architecture: 'x64' }

test.describe('opt-in private failure report @smoke', () => {
  test('has enough useful diagnostics without any raw sensitive values', () => {
    const report = createFailureReport(state, environment)
    expect(report).toContain('HTTP 403')
    expect(report).toContain('Recent failed HTTP statuses: 403, 403, 429')
    expect(report).toContain('Range support: yes')
    expect(report).toContain('ETag present: yes')
    expect(report).toContain('Last-Modified present: no')
    expect(report).toContain('usb: 1')
    expect(report).toContain('Plexo version: 1.0.0-rc.15')
    for (const forbidden of ['secret.example.test', 'api-secret-9283', 'session-secret',
      'movie-secret', '/Users/alice', '192.168.2.4', 'Secret USB Router', 'private-download-uuid']) {
      expect(report).not.toContain(forbidden)
    }
    const draft = new URL(githubFailureReportUrl(report))
    expect(draft.origin).toBe('https://github.com')
    expect(draft.pathname).toBe('/anmolkapil/plexo/issues/new')
    expect(draft.searchParams.get('body')).toContain(report)
  })

  test('ignores untrusted error text, enum values and invalid status history', () => {
    const poisoned = {
      ...state,
      error: `couldn't open ${secret} for user alice@example.test`,
      recentHttpStatuses: [403, 9999, -1, 503, 200, 401, 420, 429],
      networks: [{ ...network, kind: secret as 'usb', status: secret as 'failed' }]
    }
    const report = createFailureReport(poisoned, {
      appVersion: secret,
      os: secret,
      architecture: 'x64'
    })
    expect(report).toContain('Failure: Other failure (details withheld)')
    expect(report).toContain('Recent failed HTTP statuses: 503, 200, 401, 420, 429')
    expect(report).toContain('Plexo version: unknown')
    expect(report).not.toContain('secret.example.test')
    expect(report).not.toContain('alice@example.test')
    expect(report).not.toContain('9999')
  })

  test('old downloads without diagnostics show unknown rather than inventing measurements', () => {
    const legacy = { ...state, supportsRanges: undefined, etagPresent: undefined,
      lastModifiedPresent: undefined, recentHttpStatuses: undefined }
    const report = createFailureReport(legacy, environment)
    expect(report).toContain('Range support: unknown')
    expect(report).toContain('ETag present: unknown')
    expect(report).toContain('Recent failed HTTP statuses: not recorded')
  })

  test('torrent reports contain counts but never peer identity or hashes', () => {
    const torrent: DownloadState = {
      ...state,
      kind: 'torrent',
      networks: [{ ...network, transfer: 'torrent', bytesUploaded: 0, uploadSpeedBytesPerSec: 0 }],
      peers: [{
        id: 0, interfaceId: secret, status: 'connected', client: secret,
        bytesDownloaded: 0, speedBytesPerSec: 0, bytesUploaded: 0, uploadSpeedBytesPerSec: 0
      }],
      peakPeers: 2, pieces: [], totalPieces: 0, pieceLength: 1024,
      files: { chosen: 1, total: 1 }, folder: false, skippedBytes: 0,
      bytesUploaded: 0, uploadSpeedBytesPerSec: 0
    }
    const report = createFailureReport(torrent, environment)
    expect(report).toContain('Peers at failure: 1')
    expect(report).toContain('Peak peers: 2')
    expect(report).not.toContain('secret.example.test')
  })
})
