import type { DownloadState, FinishedDownload } from '@shared/types'
import { linkExpired } from './format'

/** Everything the app can do to a download, decided in one place. The row's button, the
 * right-click menu, the selection toolbar and a download's own screen all read this list, so
 * they can't disagree about what is offered, when, or in what order. How an action is named,
 * drawn and confirmed is in components/downloadActionMeta.ts and DownloadActionsProvider.tsx. */
export type ActionId =
  | 'pause'
  | 'resume'
  | 'retry'
  | 'fix'
  | 'again'
  | 'open'
  | 'reveal'
  | 'copy'
  | 'cancel'
  | 'remove'
  | 'trash'

export type DownloadItem = DownloadState | FinishedDownload

export const isFinished = (item: DownloadItem): item is FinishedDownload => 'unitsWritten' in item
export const isDone = (item: DownloadItem): boolean =>
  isFinished(item) || item.status === 'completed'
export const isFailed = (item: DownloadItem): item is DownloadState =>
  !isFinished(item) && item.status === 'error'
/** Going, waiting or paused: stopping it deletes what it downloaded so far. */
export const isCancellable = (item: DownloadItem): item is DownloadState =>
  !isFinished(item) && ['downloading', 'queued', 'paused'].includes(item.status)
/** Finished, but its file is no longer where it was saved. */
export const isMissing = (item: DownloadItem): boolean => isFinished(item) && !!item.missing
/** Finished, with its file (or a torrent's own files) still there to move to the Trash. */
export const isTrashable = (item: DownloadItem): boolean =>
  isDone(item) &&
  !isMissing(item) &&
  (item.kind !== 'torrent' || !item.folder || !isFinished(item) || !!item.downloadedFiles?.length)

/** What a failed download can do next. `fix`: its link stopped working, a fresh one carries on
 * from here. `retry`: what it saved is still there to pick up from. `again`: nothing of it can
 * be kept, so it starts over from its link (a retry with nothing saved has no partial file to
 * resume). */
export type FailureAction = 'fix' | 'retry' | 'again'

export function failureAction(download: DownloadState): FailureAction {
  if (linkExpired(download)) return 'fix'
  return download.resumable !== false && download.bytesDownloaded > 0 ? 'retry' : 'again'
}

const appliesTo: Record<ActionId, (item: DownloadItem) => boolean> = {
  pause: (item) => !isFinished(item) && (item.status === 'downloading' || item.status === 'queued'),
  resume: (item) => !isFinished(item) && item.status === 'paused',
  retry: (item) => isFailed(item) && failureAction(item) === 'retry',
  fix: (item) => isFailed(item) && failureAction(item) === 'fix',
  again: (item) => isFailed(item) && failureAction(item) === 'again',
  open: (item) => isDone(item) && !isMissing(item),
  reveal: (item) => (isDone(item) && !isMissing(item)) || isCancellable(item),
  copy: (item) => /^(https?:|magnet:)/i.test(item.url),
  cancel: isCancellable,
  remove: (item) => isDone(item) || isFailed(item),
  trash: isTrashable
}

/** These make sense for one download at a time: with several selected, they aren't offered. */
const SINGLE_ONLY: ReadonlySet<ActionId> = new Set(['fix', 'again', 'open', 'reveal'])

/** The order they're shown in, in groups: what to do with it, its link, getting rid of it.
 * Menus put a separator between groups. */
export const ACTION_GROUPS: readonly (readonly ActionId[])[] = [
  ['pause', 'resume', 'retry', 'fix', 'again', 'open', 'reveal'],
  ['copy'],
  ['cancel', 'remove', 'trash']
]

export interface AvailableAction {
  id: ActionId
  /** The downloads it applies to: with a mixed selection, only the ones it's valid for. */
  targets: DownloadItem[]
}

/** What can be done to these downloads, in display order and in groups. An action is offered
 * when it's valid for at least one of them, and then acts on just those. */
export function availableActions(items: DownloadItem[]): AvailableAction[][] {
  return ACTION_GROUPS.map((group) =>
    group.flatMap((id): AvailableAction[] => {
      if (SINGLE_ONLY.has(id) && items.length !== 1) return []
      const targets = items.filter(appliesTo[id])
      return targets.length > 0 ? [{ id, targets }] : []
    })
  ).filter((group) => group.length > 0)
}

/** The single button a row shows when idle: the next step for that download, if it has one. */
export const ROW_ACTIONS: readonly ActionId[] = ['pause', 'resume', 'retry', 'fix', 'again']

export function rowAction(item: DownloadItem): ActionId | null {
  return ROW_ACTIONS.find((id) => appliesTo[id](item)) ?? null
}

/** The ways out of a download from its own screen, in the order the menu has them: Cancel while
 * it's unfinished; Remove from the list, and moving its file to the Trash, after. */
export const MANAGE_ACTIONS: readonly ActionId[] = ['cancel', 'remove', 'trash']

export function manageActions(item: DownloadItem): ActionId[] {
  return MANAGE_ACTIONS.filter((id) => appliesTo[id](item))
}

/** The one of them every download that can be taken away has. */
export function manageAction(item: DownloadItem): ActionId | null {
  return (['cancel', 'remove'] as const).find((id) => appliesTo[id](item)) ?? null
}

/** What a download's own screen offers beside that: its next steps, in order. */
export const HEADER_ACTIONS: readonly ActionId[] = [...ROW_ACTIONS, 'open', 'reveal']

export function headerActions(item: DownloadItem): ActionId[] {
  return HEADER_ACTIONS.filter((id) => appliesTo[id](item))
}
