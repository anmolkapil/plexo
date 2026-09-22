import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, rm, stat, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

// Where a block's bytes live while a download is in progress. A block's own file (`part-N`) holds
// it from its first byte on and only ever grows by appending, so its size is always a valid
// prefix of the block. A racing attempt (see scheduler.ts) writes its own file, and only becomes
// part of `part-N` if it wins.

export const partFile = (dir: string, blockIndex: number): string => join(dir, `part-${blockIndex}`)

export const hedgeFile = (dir: string, blockIndex: number, streamId: number): string =>
  join(dir, `part-${blockIndex}.hedge-${streamId}`)

/** Bytes on disk in `path`; 0 if it doesn't exist. */
export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

// A part file's on-disk size is the only thing we can actually trust across a retry or resume —
// appending opens the file with flag 'a', which always writes at the real end-of-file regardless
// of what byte count we think we're at, so any mismatch (a crash, a write that hadn't flushed
// yet) would otherwise silently shift every byte after it. Truncating to the smaller of the two
// counts keeps the part file's length and our own bookkeeping in agreement before we append
// another byte to it.
export async function reconcilePartFileSize(
  partPath: string,
  expectedBytes: number
): Promise<number> {
  const actualBytes = await fileSize(partPath)
  const safeBytes = Math.min(expectedBytes, actualBytes)
  if (actualBytes !== safeBytes) {
    await truncate(partPath, safeBytes)
  }
  return safeBytes
}

/**
 * Finishes a block from a racing attempt's file: keeps the block's first `hedgeStart` bytes and
 * appends what the hedge fetched from there to the end. Only valid once nothing else is writing
 * the part file.
 *
 * Resolves true when the part file then holds all `blockBytes`. Resolves false when the two
 * don't fit together — the part file holds less than `hedgeStart` (bytes its writer never
 * flushed), the hedge's file isn't the size its range says, or the joined file comes out the
 * wrong size — and in every such case the part file is left holding exactly the bytes it had
 * before the join point and nothing after it, which are known good. If the copy itself fails it
 * throws, leaving the part file a valid prefix of the block, the same state a crash would.
 */
export async function mergeHedge(
  partPath: string,
  hedgePath: string,
  hedgeStart: number,
  blockBytes: number
): Promise<boolean> {
  if ((await fileSize(hedgePath)) !== blockBytes - hedgeStart) return false
  if ((await fileSize(partPath)) < hedgeStart) return false

  if (hedgeStart > 0) await truncate(partPath, hedgeStart)
  await pipeline(
    createReadStream(hedgePath),
    createWriteStream(partPath, { flags: hedgeStart > 0 ? 'a' : 'w' })
  )
  if ((await fileSize(partPath)) === blockBytes) return true

  // Something else wrote to the file mid-join, so nothing past the join can be trusted.
  await truncate(partPath, hedgeStart)
  return false
}

/** Removes racing attempts' files left in `dir` — by a crash, or a pause that abandoned them. */
export async function removeHedgeFiles(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((name) => name.includes('.hedge-'))
      .map((name) => rm(join(dir, name), { force: true }))
  )
}
