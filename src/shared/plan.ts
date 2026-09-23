// How a download is cut into blocks and how many streams work on them. Pure, and shared, so the
// main process (which does the cutting) and the start screen (which previews the stream count)
// cannot disagree about it.

const MIB = 1024 * 1024

/** The largest block, for any file the block-count cap doesn't force bigger. */
export const DEFAULT_MAX_BLOCK_BYTES = 8 * MIB

/** No block is planned smaller than this: each block is its own request, and below about a
 * megabyte the round trips cost more than splitting the file saves. */
export const MIN_BLOCK_BYTES = MIB

/** Only a safety valve for multi-terabyte files, so the block list stays a sane size. Past it,
 * blocks grow instead of multiplying. */
export const MAX_BLOCKS = 4096

export const MAX_STREAMS_PER_NETWORK = 8
export const MAX_STREAMS = 32

/** Blocks planned per stream, at least. Streams pull blocks as they free up, so a fast network
 * takes more of them — but only if there are more blocks than streams to begin with. With one
 * block each, a stream on a slow network would hold its block while the rest sat idle. */
const BLOCKS_PER_STREAM = 2
/** …and never fewer than this many per network, whatever the stream count. */
const MIN_BLOCKS_PER_NETWORK = 4

export interface DownloadPlan {
  /** Bytes per block; the last block holds the remainder. */
  blockSizeBytes: number
  blockCount: number
  /** The network (an index into the selected networks) each stream runs on, in the order the
   * streams start — interleaved, so every network is served before any is served twice. */
  streamNetworks: number[]
}

export interface PlanRequest {
  /** 0 when unknown. */
  totalBytes: number
  /** false when the server can't serve byte ranges. */
  splittable: boolean
  networkCount: number
  /** Streams wanted on each network. */
  streamsPerNetwork: number
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

  // One request has to carry the whole file, so one stream, on the first network.
  if (!splittable || totalBytes <= 0) {
    return { blockSizeBytes: Math.max(totalBytes, 0), blockCount: 1, streamNetworks: [0] }
  }

  const maxBlockBytes = request.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES
  const requested = clamp(Math.floor(request.streamsPerNetwork), 1, MAX_STREAMS_PER_NETWORK)

  const targetBlocks =
    networkCount * Math.max(MIN_BLOCKS_PER_NETWORK, requested * BLOCKS_PER_STREAM)
  const blockSizeBytes = Math.max(
    clamp(
      Math.ceil(totalBytes / targetBlocks),
      Math.min(MIN_BLOCK_BYTES, maxBlockBytes),
      maxBlockBytes
    ),
    Math.ceil(totalBytes / MAX_BLOCKS)
  )
  const blockCount = Math.ceil(totalBytes / blockSizeBytes)

  // A stream with no block to claim would only sit idle, so a small file gets fewer of them —
  // but every network keeps one, so it still shows up and can take over a block that fails.
  const perNetwork = Math.max(1, Math.min(requested, Math.ceil(blockCount / networkCount)))
  const streamNetworks = interleave(
    Array.from({ length: networkCount * perNetwork }, (_, i) => Math.floor(i / perNetwork)),
    (network) => network
  ).slice(0, MAX_STREAMS)

  return { blockSizeBytes, blockCount, streamNetworks }
}
