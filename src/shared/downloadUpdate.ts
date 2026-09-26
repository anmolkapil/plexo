import type { DownloadState, DownloadUpdate } from './types'

/** The download as `current` plus `update`: what anything watching a download keeps. */
export function applyDownloadUpdate(
  current: DownloadState | null,
  update: DownloadUpdate
): DownloadState | null {
  const { state, blocks: changed, seq } = update
  if (current?.id === state.id) {
    // A snapshot taken after this was sent already has it.
    if ((current.seq ?? 0) >= seq) return current
    // A new array only when a block changed, so what shows the blocks can tell when they did.
    let blocks = current.blocks
    if (changed.length > 0) {
      blocks = [...(blocks ?? [])]
      for (const block of changed) blocks[block.index] = block
    }
    return { ...state, blocks, seq }
  }
  // Another download: only an update with every block in it stands on its own — the first one
  // sent for a download, or a snapshot. Until one comes there is nothing whole to show.
  if (changed.length < (state.totalBlocks ?? 0)) return current
  return { ...state, blocks: changed, seq }
}
