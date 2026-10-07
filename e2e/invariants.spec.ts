import { expect, test } from '@playwright/test'
import type { HttpDownloadState } from '../src/shared/types'
import { checkEvents } from './fixtures'

const paused = (): HttpDownloadState => ({
  kind: 'http',
  id: 'invariant-download',
  url: 'http://example.test/file',
  fileName: 'file',
  destinationPath: '/tmp/file',
  totalBytes: 100,
  bytesDownloaded: 100,
  speedBytesPerSec: 0,
  status: 'paused',
  networks: [],
  streams: [],
  peakStreams: 0,
  totalBlocks: 1,
  blockSizeBytes: 100,
  startedAt: 0,
  blocks: [
    {
      kind: 'http',
      index: 0,
      rangeStart: 0,
      rangeEnd: 99,
      status: 'completed',
      bytesDownloaded: 100,
      bytesByInterface: { a: 100 }
    }
  ]
})

test('event validation retains integrity failures and download context', () => {
  const valid = paused()
  expect(() =>
    checkEvents([[valid, { ...valid, status: 'downloading' }, { ...valid, status: 'completed' }]])
  ).not.toThrow()

  const corrupt = paused()
  corrupt.blocks[0].bytesByInterface.a = 99
  expect(() => checkEvents([[corrupt]])).toThrow(/invariant-download.*unit 0 attribution/)

  const short = paused()
  short.blocks[0].bytesDownloaded = 99
  short.blocks[0].bytesByInterface.a = 99
  expect(() => checkEvents([[short]])).toThrow(/invariant-download.*completed unit 0 is full/)

  expect(() => checkEvents([[{ ...valid, status: 'completed' }, valid]])).toThrow(
    /completed → paused/
  )
})

test('event validation checks long histories without per-block report steps', () => {
  const state = paused()
  state.blocks = Array.from({ length: 256 }, (_, index) => ({
    ...state.blocks[0],
    index,
    rangeStart: index * 100,
    rangeEnd: index * 100 + 99
  }))
  state.totalBlocks = state.blocks.length
  state.totalBytes = state.bytesDownloaded = state.totalBlocks * 100
  const history = Array.from({ length: 1000 }, () => state)
  expect(() => checkEvents([history])).not.toThrow()
  // A failure at the end must still be inspected, rather than sampling a large history.
  const bad = { ...state, bytesDownloaded: state.totalBytes + 1 }
  expect(() => checkEvents([[...history, bad]])).toThrow(/bytesDownloaded ≤ totalBytes/)
})
