import type { DownloadState, DownloadUpdate } from './types'

/** The download as `current` plus `update`: what anything watching a download keeps. */
export function applyDownloadUpdate(
  current: DownloadState | null,
  update: DownloadUpdate
): DownloadState | null {
  if ('blocks' in update) {
    const { state, blocks: changed, seq } = update
    if (current?.id === state.id && current.kind === 'http') {
      if ((current.seq ?? 0) >= seq) return current
      let blocks = current.blocks
      if (changed.length > 0) {
        blocks = [...blocks]
        for (const block of changed) blocks[block.index] = block
      }
      return { ...state, blocks, seq }
    }
    if (changed.length < state.totalBlocks) return current
    return { ...state, blocks: changed, seq }
  }

  const { state, pieces: changed, seq } = update
  if (current?.id === state.id && current.kind === 'torrent') {
    if ((current.seq ?? 0) >= seq) return current
    let pieces = current.pieces
    if (changed.length > 0) {
      pieces = [...pieces]
      for (const piece of changed) pieces[piece.index] = piece
    }
    return { ...state, pieces, seq }
  }
  if (changed.length < state.totalPieces) return current
  return { ...state, pieces: changed, seq }
}
