import type { DownloadStatus } from './types'

export type TaskbarProgressMode = 'normal' | 'paused' | 'indeterminate' | 'none'

export interface TaskbarProgressResult {
  progress: number
  mode: TaskbarProgressMode
}

export interface TaskbarDownload {
  status: DownloadStatus
  totalBytes: number
  bytesDownloaded: number
  kind?: 'http' | 'torrent' | 'nzb' | 'telegram'
  skippedBytes?: number
  missingBytes?: number
}

/** What a download fetches: all of it, bar a torrent's pieces no chosen file needs and an NZB's
 * articles the server doesn't have. */
export function wantedBytes(
  download: Pick<TaskbarDownload, 'totalBytes' | 'kind' | 'skippedBytes' | 'missingBytes'>
): number {
  return (
    download.totalBytes -
    (download.kind === 'torrent'
      ? (download.skippedBytes ?? 0)
      : download.kind === 'nzb'
        ? (download.missingBytes ?? 0)
        : 0)
  )
}

/**
 * Calculates overall taskbar progress across active or paused downloads.
 * Returns progress between 0 and 1 (or 2 for indeterminate, -1 for none) and the mode.
 */
export function taskbarProgress(states: Iterable<TaskbarDownload>): TaskbarProgressResult {
  const downloading: TaskbarDownload[] = []
  const paused: TaskbarDownload[] = []

  for (const s of states) {
    if (s.status === 'downloading') {
      downloading.push(s)
    } else if (s.status === 'paused') {
      paused.push(s)
    }
  }

  if (downloading.length === 0) {
    if (paused.length > 0) {
      let totalWanted = 0
      let downloaded = 0
      for (const r of paused) {
        const wanted = wantedBytes(r)
        if (wanted > 0) {
          totalWanted += wanted
          downloaded += r.bytesDownloaded || 0
        }
      }
      if (totalWanted > 0) {
        const ratio = Math.min(Math.max(downloaded / totalWanted, 0), 1)
        return { progress: ratio, mode: 'paused' }
      }
    }
    return { progress: -1, mode: 'none' }
  }

  let totalWanted = 0
  let downloaded = 0
  let indeterminate = false

  for (const r of downloading) {
    const wanted = wantedBytes(r)
    if (wanted > 0) {
      totalWanted += wanted
      downloaded += r.bytesDownloaded || 0
    } else {
      indeterminate = true
    }
  }

  if (indeterminate && totalWanted === 0) {
    return { progress: 2, mode: 'indeterminate' }
  }

  if (totalWanted > 0) {
    const ratio = Math.min(Math.max(downloaded / totalWanted, 0), 1)
    return { progress: ratio, mode: 'normal' }
  }

  return { progress: -1, mode: 'none' }
}
