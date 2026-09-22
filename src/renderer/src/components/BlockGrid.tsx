import type { BlockState, BlockStatus } from '@shared/types'
import { useCallback, useRef, useState } from 'react'
import type { NetworkVisual } from '../theme'
import { formatBytes, type NetworkGroup } from '../utils/format'

// The grid is a byte-space map of the file: one square per chunk, running left-to-right,
// top-to-bottom. Each square is drawn in exactly one network's color — a square reads as one
// network's work, never as a gradient. Which network that is comes from per-network byte tallies
// (see describeBlocks), so the winner is whoever truly moved the most bytes there, including when
// a chunk changed hands mid-flight after a dropped connection or a pause/resume. Hovering reads
// out the exact split.
//
// Vocabulary is the same as the streams table's: a *chunk* is one real 8 MB unit the downloader
// actually fetches (what NetworkRow labels "Chunk #N"), and every chunk gets its own square. No
// grouping, no averaging — square #7 is chunk #7, so a hovered square points at exactly the work
// one stream did and the two views can be read against each other directly.
//
// A big file therefore makes a tall grid rather than a coarser one. Past MAX_VISIBLE_ROWS the
// grid scrolls instead of growing without bound or shrinking its squares: keeping the squares at
// a fixed size is what keeps them the same unit of meaning on every download, and the scroll
// height is what a multi-gigabyte file's chunk count honestly looks like.
const TARGET_CELL_PX = 12
const CELL_GAP_PX = 3
const CELL_HEIGHT_PX = 13
const MIN_COLS = 8

// Ceiling on grid squares, above which consecutive units share one square.
//
// The 1:1 rule above holds for HTTP because that engine caps itself at the same number by
// growing its block size instead of its block count. A torrent can't: its piece size is fixed
// by the torrent, so a 6 GB ISO at 256 KB pieces is 24,729 of them. One square each would be
// 24,729 elements reconciled on every progress push, to draw detail finer than a pixel. Above
// the cap the grid stays a faithful byte-space map, just at a coarser resolution — and it says
// so, rather than quietly implying one square is still one piece.
const MAX_CELLS = 4096
// Rows visible before the grid starts scrolling.
const MAX_VISIBLE_ROWS = 6
// Room for the hover outline (1.5px, offset 1) so it isn't clipped against the scroll edges.
const GRID_INSET_PX = 3

// A cell whose bytes can't be traced to a network must not borrow a network's color: the brand
// amber IS the USB network's color (--color-accent and --color-usb are the same hex), so the old
// accent fallback rendered every unattributed cell as though the USB network had downloaded it.
// Unknown provenance reads as neutral gray instead, which is honest and impossible to misread.
const UNATTRIBUTED_SOLID = 'var(--text-tertiary)'
const UNATTRIBUTED_BG = 'var(--track-bg)'

// Assembled bytes are deliberately not painted in any network's color: once a chunk is stitched
// onto disk it isn't "that network's work" anymore so much as "already part of the file", and a
// dedicated neutral tone is what makes the sweep across the grid read as progress rather than as
// chunks quietly losing their color for no reason.
const ASSEMBLED_SOLID = 'var(--text)'

/** One network's share of a cell's downloaded bytes. */
interface CellSegment {
  interfaceId: string
  bytes: number
}

interface DisplayCell {
  status: BlockStatus
  /** The network that delivered the most bytes here — what the cell reads out as, and what
   * colors it when its share is drawn as a single block. */
  interfaceId?: string
  /** Every network that delivered bytes here, in legend order. The square itself is painted a
   * single color (`interfaceId`), but this is what decides that winner honestly and what the
   * hover readout breaks down, so a cell shared between networks still says so. */
  segments: CellSegment[]
  fillRatio: number
  totalBytes: number
  bytesDownloaded: number
  /** 1-based number of the first unit in this square, matching the badges in the streams table
   * so a hovered square points back at a specific stream's work. */
  chunkNumber: number
  /** How many units this square stands for — 1 unless the grid is above MAX_CELLS. */
  cellSpan: number
}

/** Describes each chunk as one grid square.
 *
 * Attribution comes from a block's per-network byte tallies, never from its current
 * `interfaceId`: that field is only the worker holding the block right now, so a block that a
 * retry or a pause/resume handed from one network to another would otherwise be repainted in the
 * finishing network's color. `orderedInterfaceIds` fixes the order contributors are listed in, so
 * a square's readout doesn't reshuffle between progress pushes. */
function describeBlocks(
  blocks: BlockState[],
  orderedInterfaceIds: string[],
  blocksPerCell: number
): DisplayCell[] {
  const cells: DisplayCell[] = []

  for (let start = 0; start < blocks.length; start += blocksPerCell) {
    const span = blocks.slice(start, start + blocksPerCell)
    const bytesByInterface = new Map<string, number>()
    let totalBytes = 0
    let bytesDownloaded = 0
    let anyDownloading = false
    let anyError = false
    let allCompleted = true
    let activeHolder: string | undefined

    for (const block of span) {
      totalBytes += block.rangeEnd !== null ? block.rangeEnd - block.rangeStart + 1 : 0
      bytesDownloaded += block.bytesDownloaded

      if (block.status === 'downloading') {
        anyDownloading = true
        activeHolder ??= block.interfaceId
      }
      if (block.status === 'error') anyError = true
      if (block.status !== 'completed') allCompleted = false

      // Per-network tallies are the accurate source. When a block has none — bytes recorded by
      // an older main process, or a block adopted whole off disk — fall back to crediting its
      // whole byte count to the network holding it. That is the coarse attribution this
      // replaced, but it is still far better than dropping the block to "unknown".
      let tallies = Object.entries(block.bytesByInterface ?? {}).filter(([, bytes]) => bytes > 0)
      if (tallies.length === 0 && block.interfaceId && block.bytesDownloaded > 0) {
        tallies = [[block.interfaceId, block.bytesDownloaded]]
      }
      for (const [interfaceId, bytes] of tallies) {
        bytesByInterface.set(interfaceId, (bytesByInterface.get(interfaceId) ?? 0) + bytes)
      }
    }

    // In-progress beats failed beats done: a square covering many units should read as live
    // while any part of it still is. With one unit per square this is just its own status.
    let status: BlockStatus = 'pending'
    if (anyDownloading) status = 'downloading'
    else if (anyError) status = 'error'
    else if (allCompleted) status = 'completed'

    const knownOrder = orderedInterfaceIds.filter((id) => bytesByInterface.has(id))
    const extras = [...bytesByInterface.keys()].filter((id) => !orderedInterfaceIds.includes(id))
    const segments: CellSegment[] = [...knownOrder, ...extras].map((interfaceId) => ({
      interfaceId,
      bytes: bytesByInterface.get(interfaceId)!
    }))

    let dominantInterfaceId: string | undefined
    let dominantBytes = 0
    for (const segment of segments) {
      if (segment.bytes > dominantBytes) {
        dominantBytes = segment.bytes
        dominantInterfaceId = segment.interfaceId
      }
    }

    cells.push({
      status,
      // Before any bytes land, work in flight is still fairly labelled by the network that is
      // fetching it — but only then.
      interfaceId: dominantInterfaceId ?? activeHolder,
      segments,
      fillRatio: totalBytes > 0 ? bytesDownloaded / totalBytes : 0,
      totalBytes,
      bytesDownloaded,
      chunkNumber: start + 1,
      cellSpan: span.length
    })
  }

  return cells
}

/** Names the networks behind a cell: one name when a single network delivered it, and a
 * share-annotated list when several did — the point of the split coloring is that the user can
 * see, and read out, that a square was a joint effort. */
function describeContributors(
  cell: DisplayCell,
  visualByInterfaceId: Map<string, NetworkVisual>
): string | undefined {
  const named = cell.segments
    .filter((segment) => segment.bytes > 0)
    .map((segment) => ({
      name: visualByInterfaceId.get(segment.interfaceId)?.name,
      bytes: segment.bytes
    }))
    .filter((entry): entry is { name: string; bytes: number } => Boolean(entry.name))
    .sort((a, b) => b.bytes - a.bytes)

  if (named.length === 0) {
    return cell.interfaceId ? visualByInterfaceId.get(cell.interfaceId)?.name : undefined
  }
  if (named.length === 1) return named[0].name

  const total = named.reduce((sum, entry) => sum + entry.bytes, 0)
  return named
    .map((entry) => `${entry.name} ${Math.round((entry.bytes / total) * 100)}%`)
    .join(' · ')
}

interface BlockGridProps {
  blocks?: BlockState[]
  groups: NetworkGroup[]
  visuals: NetworkVisual[]
  knownSize: boolean
  remainingBytes: number
  isPaused?: boolean
  /** What one unit of this download is called. An HTTP download fetches 8 MB chunks of its own
   * choosing; a torrent fetches pieces, whose size and count the torrent itself fixes. Calling
   * a piece a chunk would misname the one thing the grid is a map of. */
  unit?: 'chunk' | 'piece'
  /** All blocks are 'completed' by the time this is true — the grid switches from showing which
   * network fetched each chunk to showing reassembly progress instead: a wipe, in the same
   * part-file order `reassemble()` actually writes in, that fades a square once its bytes are
   * safely on disk and pulses whichever one is being appended right now. Without this the grid
   * would freeze solid the moment the last byte downloads, and assembling a large file can take
   * long enough that a frozen grid reads as hung rather than finishing up. */
  assembling?: boolean
  assembledBytes?: number
}

export function BlockGrid({
  blocks,
  groups,
  visuals,
  knownSize,
  remainingBytes,
  isPaused = false,
  unit = 'chunk',
  assembling = false,
  assembledBytes = 0
}: BlockGridProps): React.JSX.Element {
  const [gridWidth, setGridWidth] = useState(0)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  // A callback ref rather than useEffect: the measured node only exists on the grid branch
  // below, so this has to re-observe whenever that node mounts or unmounts.
  const measureGrid = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      setGridWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  if (blocks && blocks.length > 1) {
    const visualByInterfaceId = new Map<string, NetworkVisual>()
    groups.forEach((g, idx) => {
      if (visuals[idx]) {
        visualByInterfaceId.set(g.interfaceId, visuals[idx])
      }
    })

    const fittedCols = Math.floor((gridWidth + CELL_GAP_PX) / (TARGET_CELL_PX + CELL_GAP_PX))
    // Squares keep their size and the grid wraps; how many rows that takes is the file's business,
    // not the window's. Only the width decides the wrap, exactly like a paragraph reflowing.
    const blocksPerCell = Math.ceil(blocks.length / MAX_CELLS)
    const cellCount = Math.ceil(blocks.length / blocksPerCell)
    const cols = Math.min(cellCount, Math.max(MIN_COLS, fittedCols))
    const orderedInterfaceIds = groups.map((g) => g.interfaceId)
    const cells = gridWidth > 0 ? describeBlocks(blocks, orderedInterfaceIds, blocksPerCell) : []
    const chunkBytes =
      blocks[0].rangeEnd !== null ? blocks[0].rangeEnd - blocks[0].rangeStart + 1 : 0
    const unitPlural = `${unit}s`
    const rows = Math.ceil(cellCount / cols)
    const visibleRows = Math.min(rows, MAX_VISIBLE_ROWS)
    // Cut the viewport exactly on a row boundary, so a scrollable grid never shows a half-row
    // that could be mistaken for a shorter square.
    const gridMaxHeight =
      visibleRows * CELL_HEIGHT_PX + (visibleRows - 1) * CELL_GAP_PX + GRID_INSET_PX * 2

    // Hovering reads out into the legend line rather than a native `title` tooltip: the grid
    // re-renders on every progress push, which resets Chromium's tooltip timer so it never
    // appears on an active block — and a tooltip advertises nothing to hover in the first place.
    const hoveredCell = hoveredIndex !== null ? cells[hoveredIndex] : undefined
    let readout: string
    if (assembling) {
      const totalBytes = cells.reduce((sum, cell) => sum + cell.totalBytes, 0)
      readout = `Assembling into file · ${formatBytes(assembledBytes)} / ${formatBytes(totalBytes)}`
    } else if (hoveredCell) {
      const where =
        describeContributors(hoveredCell, visualByInterfaceId) ??
        (hoveredCell.status === 'pending' ? 'queued' : '—')
      const label =
        hoveredCell.cellSpan > 1
          ? `${unitPlural} #${hoveredCell.chunkNumber}–${hoveredCell.chunkNumber + hoveredCell.cellSpan - 1}`
          : `${unit} #${hoveredCell.chunkNumber}`
      readout = `${label} · ${formatBytes(hoveredCell.bytesDownloaded)} / ${formatBytes(hoveredCell.totalBytes)} · ${where}`
    } else {
      const scrollHint = rows > MAX_VISIBLE_ROWS ? ' · scroll' : ''
      // Says outright when a square is no longer one unit, so the map isn't read finer than it is.
      const density = blocksPerCell > 1 ? ` · ${blocksPerCell} per square` : ''
      readout = `${blocks.length.toLocaleString()} ${unitPlural} · ${formatBytes(chunkBytes)} each${density}${scrollHint}`
    }

    // Cumulative byte offset per cell, in the exact order reassemble() appends part files —
    // computed once here rather than per-cell so each square's assembly state is a simple
    // range comparison against `assembledBytes` below.
    const assembleOffsets = cells.reduce<{ offsets: number[]; total: number }>(
      (acc, cell) => {
        acc.offsets.push(acc.total)
        acc.total += cell.totalBytes
        return acc
      },
      { offsets: [], total: 0 }
    ).offsets

    return (
      <div className="flex flex-col gap-[9px] rounded-[9px] border-[0.5px] border-border bg-card px-[14px] pt-[10px] pb-[11px]">
        <div className="flex flex-wrap items-center gap-[14px]">
          {groups.map((group, idx) => {
            const visual = visuals[idx]
            return (
              <div
                key={group.interfaceId}
                className="flex items-center gap-[5.5px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)]"
              >
                <span
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: visual.solid }}
                />
                <span className="font-semibold text-foreground">{visual.name}</span>
              </div>
            )
          })}
          {assembling && (
            <div className="flex items-center gap-[5.5px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)]">
              <span className="size-[7px] shrink-0 rounded-full bg-[var(--text)]" />
              <span className="font-semibold text-foreground">Assembled</span>
            </div>
          )}
          {cells.length > 0 && chunkBytes > 0 && (
            <div className="ml-auto font-mono text-[10px] leading-none font-medium tabular-nums text-muted-foreground">
              {readout}
            </div>
          )}
        </div>

        <div
          onMouseLeave={() => setHoveredIndex(null)}
          style={{
            maxHeight: gridMaxHeight,
            // gridMaxHeight is measured including the inset padding, so say so rather than
            // leaning on the global reset — a content-box here would cut a half-row.
            boxSizing: 'border-box',
            overflowY: rows > MAX_VISIBLE_ROWS ? 'auto' : 'visible',
            // The scrollbar takes width from the grid, and the ResizeObserver sits on the grid
            // itself rather than this scroller, so the column count already accounts for it.
            padding: GRID_INSET_PX,
            margin: -GRID_INSET_PX
          }}
        >
          <div
            ref={measureGrid}
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gap: CELL_GAP_PX,
              width: '100%',
              minHeight: CELL_HEIGHT_PX
            }}
          >
            {cells.map((cell, index) => {
              const visual = cell.interfaceId
                ? visualByInterfaceId.get(cell.interfaceId)
                : undefined

              // Base track uses theme-aware tokens (not hardcoded white-based rgba) so a
              // mostly-pending bucket stays visible in light theme, not just dark.
              let background = 'var(--track-bg)'
              let border = '0.5px solid var(--border-strong)'
              let boxShadow = 'none'
              let opacity = 1
              let fillColor = visual?.solid || UNATTRIBUTED_SOLID

              if (cell.status === 'downloading') {
                background = visual?.bg || UNATTRIBUTED_BG
                border = `1px solid ${visual?.solid || UNATTRIBUTED_SOLID}`
                boxShadow = isPaused ? 'none' : `0 0 7px ${visual?.solid || UNATTRIBUTED_SOLID}`
                opacity = isPaused ? 0.6 : 1
              } else if (cell.status === 'error') {
                fillColor = 'var(--color-danger)'
                border = 'none'
              } else if (cell.status === 'completed') {
                border = 'none'
                opacity = 0.92
              }

              let animation: string | undefined
              if (assembling) {
                const start = assembleOffsets[index]
                const end = start + cell.totalBytes
                if (end <= assembledBytes) {
                  // Already appended to the destination file — turns neutral rather than just
                  // fading, so "assembled" is a distinct state you can read at a glance, not a
                  // guess at how dim is dim enough.
                  fillColor = ASSEMBLED_SOLID
                  border = 'none'
                  boxShadow = 'none'
                  opacity = 0.85
                } else if (start < assembledBytes) {
                  // The one part file being streamed onto disk right now — turning neutral too,
                  // with a pulse so the "write head" position is obvious.
                  fillColor = ASSEMBLED_SOLID
                  border = `1px solid ${ASSEMBLED_SOLID}`
                  boxShadow = `0 0 7px ${ASSEMBLED_SOLID}`
                  opacity = 1
                  animation = 'plexo-glow 0.9s ease-in-out infinite'
                } else {
                  // Completed but not yet its turn to be appended — stays in its network's color
                  // a little dimmed, to signal "waiting its turn" rather than "already assembled".
                  border = 'none'
                  boxShadow = 'none'
                  opacity = 0.75
                }
              }

              const rawFillPercent = Math.min(1, Math.max(0, cell.fillRatio)) * 100
              // A square is only ~12px wide, so the first bytes of a chunk round to nothing —
              // floor a started chunk to a visible sliver rather than 0 width.
              const fillPercent = rawFillPercent > 0 ? Math.max(6, Math.round(rawFillPercent)) : 0

              return (
                <div
                  key={index}
                  onMouseEnter={() => setHoveredIndex(index)}
                  style={{
                    position: 'relative',
                    height: CELL_HEIGHT_PX,
                    borderRadius: 2.5,
                    background,
                    border,
                    boxShadow,
                    opacity,
                    animation,
                    outline: hoveredIndex === index ? '1.5px solid var(--text-secondary)' : 'none',
                    outlineOffset: 1,
                    overflow: 'hidden',
                    transition: 'opacity 0.3s, box-shadow 0.15s',
                    // A multi-GB file can mean thousands of cells; skip layout/paint work for the
                    // ones scrolled out of view (MAX_VISIBLE_ROWS caps what's visible, not what's
                    // rendered) rather than hand-rolling a virtualized list for a fixed-size grid.
                    contentVisibility: 'auto',
                    containIntrinsicSize: `${TARGET_CELL_PX}px ${CELL_HEIGHT_PX}px`
                  }}
                >
                  {/* One square, one color: the network that actually delivered most of this
                    square's bytes. The full per-network breakdown is still exact underneath —
                    hovering reads it out — but the grid itself stays a glanceable map of which
                    network owns which stretch of the file rather than a stack of gradients. */}
                  {fillPercent > 0 && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        width: `${fillPercent}%`,
                        background: fillColor,
                        transition: 'width 0.15s, background 0.15s'
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // Fallback for single stream / non-splittable download: clean horizontal bar
  return (
    <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-[5px] border-[0.5px] border-[var(--border-strong)] bg-[var(--track-bg)]">
      {knownSize ? (
        <>
          {groups.map((group, index) => (
            <div
              key={group.interfaceId}
              style={{
                flex: group.bytesDownloaded || 0.0001,
                background: visuals[index].solid
              }}
            />
          ))}
          <div style={{ flex: remainingBytes || 0.0001 }} />
        </>
      ) : (
        <div className="w-full bg-primary" />
      )}
    </div>
  )
}
