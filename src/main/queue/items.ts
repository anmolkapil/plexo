import type { QueueItem, QueueItemProblem, QueueLink } from '../../shared/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined

const optionalCount = (value: unknown): number | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined

/** An http(s) URL, normalized, or undefined for anything else. */
function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** A link from outside (pasted), or undefined if it isn't one. */
export function sanitizeLink(value: unknown): QueueLink | undefined {
  if (!isRecord(value)) return undefined
  const url = httpUrl(value.url)
  return url ? { url } : undefined
}

const STATUSES = new Set<string>(['queued', 'starting', 'active', 'completed', 'failed'])
const PROBLEMS = new Set<string>(['expired', 'cancelled', 'other'])

/** An item as queue.json holds it — hand-editable, or from an older version, so every field is
 * checked on its own. */
export function sanitizeStoredItem(value: unknown): QueueItem | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null
  const link = sanitizeLink(value)
  if (!link) return null
  return {
    id: value.id,
    url: link.url,
    fileName: optionalString(value.fileName, 255),
    addedAt: optionalCount(value.addedAt) ?? Date.now(),
    status: STATUSES.has(value.status as string) ? (value.status as QueueItem['status']) : 'queued',
    totalBytes: optionalCount(value.totalBytes),
    bytesDownloaded: optionalCount(value.bytesDownloaded),
    downloadId: optionalString(value.downloadId, 64),
    destinationPath: optionalString(value.destinationPath, 4096),
    error: optionalString(value.error, 2000),
    problem: PROBLEMS.has(value.problem as string)
      ? (value.problem as QueueItemProblem)
      : undefined,
    attempts: optionalCount(value.attempts) ?? 0,
    finishedAt: optionalCount(value.finishedAt)
  }
}
