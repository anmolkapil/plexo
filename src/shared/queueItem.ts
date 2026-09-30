import type { QueueItem } from './types'

/** A name for a link whose file name isn't known yet: the last part of its path. File hosts'
 * links usually end with it. */
export function nameFromUrl(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    return path.split('/').filter(Boolean).pop() || url
  } catch {
    return url
  }
}

/** The name a queue item is known by: the one it was given, or its link's. */
export const nameOf = (item: Pick<QueueItem, 'fileName' | 'url'>): string =>
  item.fileName || nameFromUrl(item.url)

/** Failed of its own accord: not cancelled, which is the user's choice, not a failure. */
export const isFailure = (item: Pick<QueueItem, 'status' | 'problem'>): boolean =>
  item.status === 'failed' && item.problem !== 'cancelled'

/** Cancelled by the user: done with, as a completed item is. */
export const isCancelled = (item: Pick<QueueItem, 'status' | 'problem'>): boolean =>
  item.status === 'failed' && item.problem === 'cancelled'
