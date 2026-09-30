import type { QueueItemProblem, ServerRefusal } from '../../shared/types'
import { HttpStatusError } from '../download/chunkDownloader'
import { NotEnoughSpaceError } from '../download/downloadManager'
import { NoCompatibleRouteError } from '../network/routes'

export interface Failure {
  problem: QueueItemProblem
  error: string
  /** Whether trying again by itself, a little later, could go differently. */
  retry: boolean
}

/** A link that stopped leading to the file: nothing but a fresh one will help. */
export class LinkExpiredError extends Error {}

const EXPIRED_MESSAGE = 'Link expired or no longer leads to the file.'

/** Statuses a link that stopped working answers with: one that ran out or was never allowed
 * (401, 403), or one whose file is gone (404, 410). */
const EXPIRED_STATUSES = new Set([401, 403, 404, 410])

/** Whether a server's answer means the link itself stopped working — as does a web page where
 * the file used to be (an error page, a login, a captcha), whatever its status. */
function isExpired(refusal: ServerRefusal): boolean {
  return EXPIRED_STATUSES.has(refusal.status) || refusal.webPage
}

/** A status a moment's wait can change: a server that is busy, briefly broken or limiting. */
const isPassing = (status: number): boolean => status >= 500 || status === 408 || status === 429

/** Why a link couldn't be started (a probe's error), in the queue's terms. */
export function classifyError(error: unknown): Failure {
  if (error instanceof LinkExpiredError) {
    return { problem: 'expired', error: error.message, retry: false }
  }
  if (error instanceof HttpStatusError) {
    if (isExpired(error)) return { problem: 'expired', error: EXPIRED_MESSAGE, retry: false }
    return { problem: 'other', error: error.message, retry: isPassing(error.status) }
  }
  const message = error instanceof Error ? error.message : String(error)
  // No network this computer has can reach the server's kind of address (IPv6 only, say).
  return { problem: 'other', error: message, retry: !(error instanceof NoCompatibleRouteError) }
}

/** Why a download failed, in the queue's terms: from what its server answered, when that is what
 * ended it (see DownloadState.refusal). It had retried its requests already; one more go, from
 * a fresh look at the link, may still get through. */
export function classifyDownload(refusal: ServerRefusal | undefined, error: string): Failure {
  return refusal && isExpired(refusal)
    ? { problem: 'expired', error: EXPIRED_MESSAGE, retry: false }
    : { problem: 'other', error, retry: true }
}

/** Errors writing to a folder, by code. */
const FOLDER_ERRORS: Record<string, string> = {
  ENOENT: 'the folder isn’t there any more (a drive unplugged?)',
  ENOTDIR: 'part of its path isn’t a folder',
  EACCES: 'Plexo isn’t allowed to write there',
  EPERM: 'Plexo isn’t allowed to write there',
  EROFS: 'the drive is read-only',
  ENOSPC: 'the drive is full'
}

/** What's wrong with the save folder, if that is why a download couldn't start: something every
 * item would run into, so the queue stops rather than failing them one by one. */
export function folderProblem(error: unknown, dir: string): string | undefined {
  const then = 'Fix that or pick another folder, then resume the queue.'
  if (error instanceof NotEnoughSpaceError) return `${error.message}. ${then}`
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code && code in FOLDER_ERRORS
    ? `Can’t save to ${dir}: ${FOLDER_ERRORS[code]}. ${then}`
    : undefined
}
