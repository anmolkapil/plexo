import type {
  DownloadState,
  DownloadUpdate,
  HttpDownloadUpdate,
  NzbDownloadUpdate,
  TorrentDownloadUpdate
} from './types'

/** `units` with the `changed` ones put in; without `units` to start from, only a snapshot (every
 * one of the `total` units) will do, and null says this update isn't one. */
function withChanged<T extends { index: number }>(
  units: T[] | undefined,
  changed: T[],
  total: number
): T[] | null {
  if (!units) return changed.length < total ? null : changed
  if (changed.length === 0) return units
  const next = [...units]
  for (const unit of changed) next[unit.index] = unit
  return next
}

/** The download as `current` plus `update`: what anything watching a download keeps. */
export function applyDownloadUpdate(
  current: DownloadState | null,
  update: DownloadUpdate
): DownloadState | null {
  const same =
    current?.id === update.state.id && current.kind === update.state.kind ? current : null
  if (same && (same.seq ?? 0) >= update.seq) return current
  const { seq } = update

  if ('pieces' in update) {
    const { state, pieces: changed } = update as TorrentDownloadUpdate
    const pieces = withChanged(
      same?.kind === 'torrent' ? same.pieces : undefined,
      changed,
      state.totalPieces
    )
    return pieces ? { ...state, pieces, seq } : current
  }
  if (update.state.kind === 'nzb') {
    const { state, blocks: changed } = update as NzbDownloadUpdate
    const blocks = withChanged(
      same?.kind === 'nzb' ? same.blocks : undefined,
      changed,
      state.totalBlocks
    )
    return blocks ? { ...state, blocks, seq } : current
  }
  const { state, blocks: changed } = update as HttpDownloadUpdate
  const blocks = withChanged(
    same?.kind === 'http' ? same.blocks : undefined,
    changed,
    state.totalBlocks
  )
  return blocks ? { ...state, blocks, seq } : current
}
