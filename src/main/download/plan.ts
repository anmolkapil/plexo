import type { BlockState } from '../../shared/types'

// How a download is cut into blocks, and how many streams a network starts on them. Pure, so
// every rule here can be checked against exact situations. How many streams a network ends up
// with is decided while the download runs (see concurrency.ts); the plan only has to leave them
// enough blocks.

const MIB = 1024 * 1024

/** The largest block. However big the file, a block stays small enough for one stream to finish
 * soon: a racing second attempt re-fetches a block rather than splitting it (see scheduler.ts),
 * so the last block's size is how long the slowest connection can hold the download up. */
export const DEFAULT_MAX_BLOCK_BYTES = 8 * MIB

/** No block is planned smaller than this: each block is its own request, and below about a
 * megabyte the round trips cost more than splitting the file saves. */
export const MIN_BLOCK_BYTES = MIB

/** Streams each network starts with, as download managers do (IDM, XDM: 8). From there it
 * doubles once they are all receiving (see concurrency.ts). */
export const START_STREAMS_PER_NETWORK = 8

/** The most streams a network can grow to (IDM's limit). Enough for a far server, where TCP holds
 * each connection to a megabyte or so a second; a server that wants fewer says so by refusing. */
export const MAX_STREAMS_PER_NETWORK = 32

/** Blocks planned per stream a network could grow to. Streams pull blocks as they free up, so a
 * fast network takes more of them — but only if there are more blocks than streams. With one
 * block each, a stream on a slow network would hold its block while the rest sat idle. */
const BLOCKS_PER_STREAM = 2

export interface DownloadPlan {
  /** Bytes per block; the last block holds the remainder. */
  blockSizeBytes: number
  blockCount: number
}

export interface PlanRequest {
  /** 0 when unknown. */
  totalBytes: number
  /** false when the server can't serve byte ranges. */
  splittable: boolean
  /** The networks it starts on. More can join later; this only sizes the blocks. */
  networkCount: number
  maxBlockBytes?: number
}

/** Lays `items` out one from each group in turn (a, b, a, b, …), keeping each group's own
 * order. Groups are visited in order of first appearance. */
export function interleave<T>(items: readonly T[], groupOf: (item: T) => unknown): T[] {
  const lanes = new Map<unknown, T[]>()
  for (const item of items) {
    const lane = lanes.get(groupOf(item))
    if (lane) lane.push(item)
    else lanes.set(groupOf(item), [item])
  }

  const out: T[] = []
  for (let round = 0; out.length < items.length; round++) {
    for (const lane of lanes.values()) {
      if (round < lane.length) out.push(lane[round])
    }
  }
  return out
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

export function planDownload(request: PlanRequest): DownloadPlan {
  const { totalBytes, splittable } = request
  const networkCount = Math.max(1, Math.floor(request.networkCount))

  // One request has to carry the whole file.
  if (!splittable || totalBytes <= 0) {
    return { blockSizeBytes: Math.max(totalBytes, 0), blockCount: 1 }
  }

  const maxBlockBytes = request.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES
  const targetBlocks = networkCount * MAX_STREAMS_PER_NETWORK * BLOCKS_PER_STREAM
  const blockSizeBytes = clamp(
    Math.ceil(totalBytes / targetBlocks),
    Math.min(MIN_BLOCK_BYTES, maxBlockBytes),
    maxBlockBytes
  )
  return { blockSizeBytes, blockCount: Math.ceil(totalBytes / blockSizeBytes) }
}

/** Streams to start on each of `networkCount` networks joining a download with `waiting` blocks
 * nobody has taken: START_STREAMS_PER_NETWORK, unless a test pins `requested`. A stream with no
 * block to claim would only sit idle, so near the end, or on a small file, fewer — but never
 * none, so a network that joins can still race a slow block (see scheduler.ts). */
export function startingStreams(
  waiting: number,
  networkCount: number,
  requested = START_STREAMS_PER_NETWORK
): number {
  const perNetwork = Math.ceil(waiting / Math.max(1, networkCount))
  return Math.max(1, Math.min(clamp(Math.floor(requested), 1, MAX_STREAMS_PER_NETWORK), perNetwork))
}

/** The blocks a file of `totalBytes` is cut into, none of them started. An unknown size is one
 * block, open-ended to the end of the file. */
export function planBlocks(totalBytes: number, blockSizeBytes: number): BlockState[] {
  const fresh = (index: number, rangeStart: number, rangeEnd: number | null): BlockState => ({
    index,
    rangeStart,
    rangeEnd,
    status: 'pending',
    bytesDownloaded: 0,
    bytesByInterface: {}
  })
  if (totalBytes <= 0) return [fresh(0, 0, null)]
  return Array.from({ length: Math.ceil(totalBytes / blockSizeBytes) }, (_, index) => {
    const rangeStart = index * blockSizeBytes
    return fresh(index, rangeStart, Math.min(rangeStart + blockSizeBytes, totalBytes) - 1)
  })
}
