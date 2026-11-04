import { expect, test } from '@playwright/test'
import { describeError, linkRefused } from '../src/shared/errors'
import type { HttpDownloadState } from '../src/shared/types'
import { linkExpired } from '../src/renderer/src/utils/format'

const refused = (status: number): string =>
  `Unexpected status ${status} for range request (http://host/file.zip)`

const errorDownload = (error: string): HttpDownloadState =>
  ({ kind: 'http', status: 'error', error }) as HttpDownloadState

test.describe('refused links @smoke', () => {
  for (const status of [401, 403, 404, 410, 416]) {
    test(`${status} during a transfer reads as a dead link`, () => {
      expect(describeError(refused(status))).toBe(
        'This link no longer works. Paste a new link to continue.'
      )
      expect(linkRefused(refused(status))).toBe(true)
      expect(linkExpired(errorDownload(refused(status)))).toBe(true)
    })
  }

  test('a server error is not a dead link', () => {
    expect(describeError(refused(503))).toBe('The server is having trouble. Try again later.')
    expect(linkRefused(refused(503))).toBe(false)
    expect(linkExpired(errorDownload(refused(503)))).toBe(false)
  })
})
