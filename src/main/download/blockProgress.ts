import type { HttpBlockState, NzbSegmentState } from '../../shared/types'

/** A block whose bytes are secured from its first one on: an HTTP block, or an NZB's article. */
type Block = HttpBlockState | NzbSegmentState

// A block's `bytesDownloaded` is its frontier: how much of it, from its first byte, is secured.
// Near the end of a download two attempts can race for one block, so the frontier is the furthest
// either has reached, not the sum of what they received. `bytesByInterface` splits it by network
// and always adds up to it — these three functions are the only ways either changes.

/** Records that `networkId` delivered `bytes` more of this block. */
function credit(block: Block, networkId: string, bytes: number): void {
  block.bytesByInterface[networkId] = (block.bytesByInterface[networkId] ?? 0) + bytes
}

/** Drops attribution for bytes that turned out not to be secured, so the per-network tallies
 * keep summing to the block's real byte count. The lost bytes are always at the tail, so they
 * come off `blamed` first (the network that wrote last) before spilling over to the rest. */
function trim(block: Block, keepBytes: number, blamed?: string): void {
  let attributed = 0
  for (const bytes of Object.values(block.bytesByInterface)) attributed += bytes

  let excess = attributed - keepBytes
  if (excess <= 0) return

  const order = Object.keys(block.bytesByInterface).sort((a, b) =>
    a === blamed ? -1 : b === blamed ? 1 : 0
  )

  for (const networkId of order) {
    if (excess <= 0) break
    const taken = Math.min(block.bytesByInterface[networkId], excess)
    const remaining = block.bytesByInterface[networkId] - taken
    excess -= taken
    if (remaining > 0) block.bytesByInterface[networkId] = remaining
    else delete block.bytesByInterface[networkId]
  }
}

/** Moves the frontier forward to `position` (a byte offset into the block), crediting the bytes
 * it gains to `networkId`. Does nothing if something already got further. Returns the gain. */
export function advanceBlock(block: Block, networkId: string, position: number): number {
  const length = block.rangeEnd === null ? Infinity : block.rangeEnd - block.rangeStart + 1
  const next = Math.min(position, length)
  const gained = next - block.bytesDownloaded
  if (gained <= 0) return 0
  block.bytesDownloaded = next
  credit(block, networkId, gained)
  return gained
}

/** Pulls the frontier back to `position`, for bytes that turned out not to be there or a racing
 * attempt that lost. `blamed` is the network they came from.
 * Returns how much it removed. */
export function retractBlock(block: Block, position: number, blamed?: string): number {
  const removed = block.bytesDownloaded - position
  if (removed <= 0) return 0
  trim(block, position, blamed)
  block.bytesDownloaded = position
  return removed
}

function resetBlock(block: HttpBlockState): void {
  block.status = 'pending'
  block.bytesDownloaded = 0
  block.bytesByInterface = {}
  block.interfaceId = undefined
}

/** Resets every in-progress block plus up to `completedCount` of the highest-index completed
 * blocks so a forced link refresh re-downloads the boundary region cleanly. Returns blocks reset. */
export function rewindBlocks(blocks: HttpBlockState[], completedCount: number): number {
  let reset = 0
  for (const block of blocks) {
    if (
      block.status !== 'completed' &&
      (block.bytesDownloaded > 0 || block.status === 'downloading')
    ) {
      resetBlock(block)
      reset += 1
    }
  }
  let remaining = Math.max(0, Math.floor(completedCount))
  for (let i = blocks.length - 1; i >= 0 && remaining > 0; i -= 1) {
    if (blocks[i].status !== 'completed') continue
    resetBlock(blocks[i])
    reset += 1
    remaining -= 1
  }
  return reset
}
