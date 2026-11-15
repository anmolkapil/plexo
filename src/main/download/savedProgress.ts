import type {
  DownloadUnitState,
  HttpBlockState,
  NzbSegmentState,
  TorrentPieceState
} from '../../shared/types'
import { planBlocks, planPieces } from './plan'

/** How a download's HTTP blocks or torrent pieces are checkpointed. Their ranges follow from the
 * transport plan, so only verified progress is durable; live, unverified piece bytes are not. */
export interface SavedBlocks {
  /** Per network id, the bytes it delivered of each block, by block index. A block is complete
   * when they add up to its length. */
  progress: Record<string, number[]>
  /** Every block is complete. Needed where a block's length is unknown — a file of unknown size
   * is one open-ended block — and so can't tell by its bytes. */
  complete: boolean
}

export function saveBlocks(blocks: readonly DownloadUnitState[]): SavedBlocks {
  const progress: Record<string, number[]> = {}
  for (const block of blocks) {
    for (const [networkId, bytes] of Object.entries(block.bytesByInterface)) {
      ;(progress[networkId] ??= new Array<number>(blocks.length).fill(0))[block.index] = bytes
    }
  }
  return { progress, complete: blocks.every((block) => block.status === 'completed') }
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

/** The blocks saved as `saved` for a download planned as `state`. The file is read back from
 * disk, so it is checked like any input: a plan that doesn't add up is refused before anything
 * is allocated for it, and progress that doesn't fit the plan is dropped — the download starts
 * its blocks over rather than trusting bytes it can't account for. */
export function restoreBlocks(
  state: { totalBytes: number; blockSizeBytes: number; totalBlocks: number },
  saved: SavedBlocks
): HttpBlockState[] | undefined {
  const { totalBytes, blockSizeBytes, totalBlocks } = state
  if (!isCount(totalBytes) || !isCount(blockSizeBytes) || !isCount(totalBlocks)) return undefined
  if ((totalBytes > 0 ? Math.ceil(totalBytes / blockSizeBytes) : 1) !== totalBlocks)
    return undefined

  const fresh = (): HttpBlockState[] => planBlocks(totalBytes, blockSizeBytes)
  const blocks = fresh()
  const columns =
    typeof saved.progress === 'object' && saved.progress !== null
      ? Object.entries(saved.progress)
      : []
  for (const [networkId, column] of columns) {
    if (!Array.isArray(column) || column.length !== blocks.length || !column.every(isCount)) {
      return fresh()
    }
    column.forEach((bytes, index) => {
      if (bytes === 0) return
      blocks[index].bytesByInterface[networkId] = bytes
      blocks[index].bytesDownloaded += bytes
    })
  }
  for (const block of blocks) {
    const length = block.rangeEnd === null ? null : block.rangeEnd - block.rangeStart + 1
    if (length !== null && block.bytesDownloaded > length) return fresh()
    if (saved.complete === true || block.bytesDownloaded === length) block.status = 'completed'
  }
  return blocks
}

export function restorePieces(
  state: { totalBytes: number; pieceLength: number; totalPieces: number },
  saved: SavedBlocks
): TorrentPieceState[] | undefined {
  const { totalBytes, pieceLength, totalPieces } = state
  if (!isCount(totalBytes) || !isCount(pieceLength) || !isCount(totalPieces) || pieceLength === 0) {
    return undefined
  }
  if (Math.ceil(totalBytes / pieceLength) !== totalPieces) return undefined

  const fresh = (): TorrentPieceState[] => planPieces(totalBytes, pieceLength)
  const pieces = fresh()
  const columns =
    typeof saved.progress === 'object' && saved.progress !== null
      ? Object.entries(saved.progress)
      : []
  for (const [networkId, column] of columns) {
    if (!Array.isArray(column) || column.length !== pieces.length || !column.every(isCount)) {
      return fresh()
    }
    column.forEach((bytes, index) => {
      if (bytes === 0) return
      pieces[index].bytesByInterface[networkId] = bytes
      pieces[index].bytesDownloaded += bytes
    })
  }
  for (const piece of pieces) {
    const length = piece.rangeEnd! - piece.rangeStart + 1
    if (piece.bytesDownloaded > length) return fresh()
    if (saved.complete === true || piece.bytesDownloaded === length) piece.status = 'completed'
  }
  return pieces
}

/**
 * An NZB download's articles as planned from its NZB (`planned`), with the progress saved for
 * them. An article only ever counts whole: one that was coming in when the download stopped
 * starts over. `missing`: the articles the server didn't have, by index. Undefined when the NZB
 * doesn't match the download saved.
 */
export function restoreSegments(
  planned: NzbSegmentState[],
  state: { totalBytes: number; totalBlocks: number },
  saved: SavedBlocks,
  missing: unknown
): NzbSegmentState[] | undefined {
  const length = (segment: NzbSegmentState): number => segment.rangeEnd! - segment.rangeStart + 1
  const total = planned.reduce((sum, segment) => sum + length(segment), 0)
  if (planned.length !== state.totalBlocks || total !== state.totalBytes) return undefined

  const columns =
    typeof saved.progress === 'object' && saved.progress !== null
      ? Object.entries(saved.progress)
      : []
  for (const [networkId, column] of columns) {
    if (!Array.isArray(column) || column.length !== planned.length || !column.every(isCount)) {
      continue
    }
    column.forEach((bytes, index) => {
      if (bytes === 0) return
      planned[index].bytesByInterface[networkId] = bytes
      planned[index].bytesDownloaded += bytes
    })
  }
  for (const segment of planned) {
    if (segment.bytesDownloaded === length(segment)) {
      segment.status = 'completed'
    } else {
      segment.bytesDownloaded = 0
      segment.bytesByInterface = {}
    }
  }
  if (Array.isArray(missing)) {
    for (const index of missing) {
      const segment = isCount(index) ? planned[index] : undefined
      if (segment?.status === 'pending') segment.status = 'missing'
    }
  }
  return planned
}
