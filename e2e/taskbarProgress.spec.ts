import { expect, test } from '@playwright/test'
import { taskbarProgress, wantedBytes, type TaskbarDownload } from '../src/shared/taskbarProgress'

test.describe('taskbar progress @smoke', () => {
  test('nothing active clears the progress bar', () => {
    expect(taskbarProgress([])).toEqual({ progress: -1, mode: 'none' })

    const nonActive: TaskbarDownload[] = [
      { status: 'completed', totalBytes: 1000, bytesDownloaded: 1000 },
      { status: 'error', totalBytes: 1000, bytesDownloaded: 200 },
      { status: 'queued', totalBytes: 1000, bytesDownloaded: 0 }
    ]
    expect(taskbarProgress(nonActive)).toEqual({ progress: -1, mode: 'none' })
  })

  test('downloading calculates combined progress in normal mode', () => {
    const single: TaskbarDownload[] = [
      { status: 'downloading', totalBytes: 1000, bytesDownloaded: 500 }
    ]
    expect(taskbarProgress(single)).toEqual({ progress: 0.5, mode: 'normal' })

    const multiple: TaskbarDownload[] = [
      { status: 'downloading', totalBytes: 1000, bytesDownloaded: 300 },
      { status: 'downloading', totalBytes: 2000, bytesDownloaded: 900 }
    ]
    // (300 + 900) / (1000 + 2000) = 1200 / 3000 = 0.4
    expect(taskbarProgress(multiple)).toEqual({ progress: 0.4, mode: 'normal' })
  })

  test('paused only shows paused progress when nothing is downloading', () => {
    const paused: TaskbarDownload[] = [{ status: 'paused', totalBytes: 1000, bytesDownloaded: 250 }]
    expect(taskbarProgress(paused)).toEqual({ progress: 0.25, mode: 'paused' })

    const multiplePaused: TaskbarDownload[] = [
      { status: 'paused', totalBytes: 2000, bytesDownloaded: 500 },
      { status: 'paused', totalBytes: 2000, bytesDownloaded: 1500 }
    ]
    // (500 + 1500) / (2000 + 2000) = 2000 / 4000 = 0.5
    expect(taskbarProgress(multiplePaused)).toEqual({ progress: 0.5, mode: 'paused' })
  })

  test('unknown size downloading shows indeterminate mode', () => {
    const unknown: TaskbarDownload[] = [
      { status: 'downloading', totalBytes: 0, bytesDownloaded: 500 }
    ]
    expect(taskbarProgress(unknown)).toEqual({ progress: 2, mode: 'indeterminate' })

    // If one has unknown size and one has known size, known size determines progress
    const mixed: TaskbarDownload[] = [
      { status: 'downloading', totalBytes: 0, bytesDownloaded: 500 },
      { status: 'downloading', totalBytes: 1000, bytesDownloaded: 750 }
    ]
    expect(taskbarProgress(mixed)).toEqual({ progress: 0.75, mode: 'normal' })
  })

  test('NZB with missing articles reaches 100% using wanted bytes', () => {
    const nzb: TaskbarDownload = {
      status: 'downloading',
      kind: 'nzb',
      totalBytes: 1000,
      missingBytes: 100,
      bytesDownloaded: 900
    }
    expect(wantedBytes(nzb)).toBe(900)
    expect(taskbarProgress([nzb])).toEqual({ progress: 1, mode: 'normal' })
  })

  test('torrent with skipped files reaches 100% using wanted bytes', () => {
    const torrent: TaskbarDownload = {
      status: 'downloading',
      kind: 'torrent',
      totalBytes: 1000,
      skippedBytes: 200,
      bytesDownloaded: 400
    }
    // wantedBytes: 1000 - 200 = 800
    expect(wantedBytes(torrent)).toBe(800)
    // 400 / 800 = 0.5
    expect(taskbarProgress([torrent])).toEqual({ progress: 0.5, mode: 'normal' })

    const finishedWanted: TaskbarDownload = {
      status: 'downloading',
      kind: 'torrent',
      totalBytes: 1000,
      skippedBytes: 200,
      bytesDownloaded: 800
    }
    expect(taskbarProgress([finishedWanted])).toEqual({ progress: 1, mode: 'normal' })

    const pausedTorrent: TaskbarDownload = {
      status: 'paused',
      kind: 'torrent',
      totalBytes: 1000,
      skippedBytes: 200,
      bytesDownloaded: 600
    }
    // 600 / 800 = 0.75
    expect(taskbarProgress([pausedTorrent])).toEqual({ progress: 0.75, mode: 'paused' })
  })
})
