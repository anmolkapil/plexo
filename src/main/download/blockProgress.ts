import type { BlockState } from '../../shared/types'

// A block's `bytesDownloaded` is its frontier: how much of it, from its first byte, is secured.
// Near the end of a download two attempts can race for one block, so the frontier is the furthest
// either has reached, not the sum of what they received. `bytesByInterface` splits it by network
// and always adds up to it — these three functions are the only ways either changes.

/** Records that `networkId` delivered `bytes` more of this block. */
function credit(block: BlockState, networkId: string, bytes: number): void {
  block.bytesByInterface[networkId] = (block.bytesByInterface[networkId] ?? 0) + bytes
}

/** Drops attribution for bytes that turned out not to be secured, so the per-network tallies
 * keep summing to the block's real byte count. The lost bytes are always at the tail, so they
 * come off `blamed` first (the network that wrote last) before spilling over to the rest. */
function trim(block: BlockState, keepBytes: number, blamed?: string): void {
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
export function advanceBlock(block: BlockState, networkId: string, position: number): number {
  const length = block.rangeEnd === null ? Infinity : block.rangeEnd - block.rangeStart + 1
  const next = Math.min(position, length)
  const gained = next - block.bytesDownloaded
  if (gained <= 0) return 0
  block.bytesDownloaded = next
  credit(block, networkId, gained)
  return gained
}

/** Pulls the frontier back to `position`, for bytes that turned out not to be there — a part file
 * shorter than counted, a racing attempt that lost. `blamed` is the network they came from.
 * Returns how much it removed. */
export function retractBlock(block: BlockState, position: number, blamed?: string): number {
  const removed = block.bytesDownloaded - position
  if (removed <= 0) return 0
  trim(block, position, blamed)
  block.bytesDownloaded = position
  return removed
}
