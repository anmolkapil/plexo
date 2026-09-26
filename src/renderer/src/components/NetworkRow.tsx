import type { BlockState, ChunkState, NetworkStatus } from '@shared/types'
import { useState } from 'react'
import { DANGER, type NetworkVisual } from '../theme'
import type { NetworkGroup } from '../utils/format'
import { formatBytes, formatSpeed } from '../utils/format'
import { ColorBadge } from './ColorBadge'
import { NetworkEditPopover } from './NetworkEditPopover'
import { TruncatedText } from './TruncatedText'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface NetworkRowProps {
  group: NetworkGroup
  visual: NetworkVisual
  sharePercent: number
  totalBytes?: number | null
  blocks?: BlockState[]
  onSwitch: (enabled: boolean) => void
}

/** What a network not in use is doing instead. One in use shows its streams. */
const STATUS_TEXT: Record<Exclude<NetworkStatus, 'on'>, string> = {
  off: 'Off',
  offline: 'Not connected',
  unreachable: 'Can’t reach server',
  failed: 'Failed'
}

// Every row — this one and each expanded stream row — is a direct col-span-full subgrid child of
// DownloadingScreen's networks grid, so all rows share one set of column tracks instead of each
// re-deriving its own and hoping they line up. The grid's side gutters live *inside* its first and
// last tracks (see NETWORK_ROW_GRID_COLUMNS), which is what lets a row's divider and fill be a
// plain border/background on the row itself: its box already reaches both window edges.
const rowClass = 'col-span-full grid grid-cols-subgrid items-center gap-3'

function ProgressBar({
  percent,
  color,
  label,
  className
}: {
  percent: number
  color: string
  label: string
  className: string
}): React.JSX.Element {
  return (
    <div
      role="cell"
      className={`w-full overflow-hidden rounded-full border-[0.5px] border-[var(--border-strong)] bg-[var(--track-bg)] ${className}`}
    >
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        className="h-full rounded-full transition-[width] duration-200 ease-out"
        style={{ width: `${percent}%`, background: color }}
      />
    </div>
  )
}

/** What an expanded stream row shows: the block that stream is working on right now and how far
 * along it is. A stream holding no block (idle, or finished) has nothing of its own to measure,
 * so it shows only what it has delivered in total. */
function describeStream(
  chunk: ChunkState,
  blocks: BlockState[] | undefined
): {
  block: BlockState | undefined
  size: number
  downloaded: number
  percent: number
  done: boolean
} {
  const block = chunk.currentBlockIndex != null ? blocks?.[chunk.currentBlockIndex] : undefined
  const done = chunk.status === 'completed' || block?.status === 'completed'
  if (!block) {
    return { block, size: 0, downloaded: chunk.bytesDownloaded, percent: done ? 100 : 0, done }
  }

  const size = block.rangeEnd !== null ? block.rangeEnd - block.rangeStart + 1 : 0
  const percent = done ? 100 : size > 0 ? Math.min(100, (block.bytesDownloaded / size) * 100) : 0
  return { block, size, downloaded: block.bytesDownloaded, percent, done }
}

export function NetworkRow({
  group,
  visual,
  sharePercent,
  totalBytes,
  blocks,
  onSwitch
}: NetworkRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasError = group.status === 'failed'
  const isActive = group.chunks.some((chunk) => chunk.status === 'downloading')

  const rounded = Math.round(sharePercent)
  const shareLabel = group.bytesDownloaded === 0 ? '0%' : rounded === 0 ? '<1%' : `${rounded}%`

  return (
    <>
      <div
        role="row"
        className={`${rowClass} border-t-[0.5px] border-[var(--border-subtle)] py-[11px]`}
      >
        <div
          role="cell"
          aria-label={hasError ? 'Error' : isActive ? 'Active' : 'Idle'}
          className="ml-5 size-2 rounded-full"
          style={{
            background: hasError ? DANGER : visual.solid,
            animation: isActive ? 'plexo-glow 1.8s infinite' : undefined,
            opacity: isActive || hasError ? 1 : 0.65
          }}
        />
        <div role="cell" className="flex min-w-0 items-center gap-[6px]">
          {/* Switching off the last network in use pauses the download. */}
          <Checkbox
            checked={group.enabled}
            onCheckedChange={(checked) => onSwitch(checked)}
            aria-label={`Use ${visual.name}`}
            className="shrink-0 data-checked:border-transparent"
            style={group.enabled ? { background: visual.solid, color: visual.onSolid } : undefined}
          />
          <TruncatedText
            text={visual.name}
            className={`font-sans text-[12.5px] leading-[1.2] font-semibold ${
              group.enabled ? 'text-foreground' : 'text-[var(--text-secondary)]'
            }`}
          />
          <NetworkEditPopover
            interfaceId={group.id}
            interfaceKind={group.kind}
            osName={group.label}
          />
          {group.chunks.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="h-auto cursor-pointer rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)] aria-expanded:bg-secondary dark:bg-card"
            >
              {group.chunks.length} {group.chunks.length === 1 ? 'stream' : 'streams'}
              <span aria-hidden className="text-[7.5px] opacity-75">
                {expanded ? '▲' : '▼'}
              </span>
            </Button>
          )}
          {group.status !== 'on' && (
            <Tooltip disabled={!group.error}>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={group.error ? 0 : undefined}
                    className={`rounded-sm font-mono text-[10px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                      hasError ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {STATUS_TEXT[group.status]}
                  </span>
                }
              />
              <TooltipContent>{group.error}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <ProgressBar
          className="h-1.5"
          label={`${visual.name} progress`}
          percent={
            totalBytes && totalBytes > 0
              ? Math.min(100, (group.bytesDownloaded / totalBytes) * 100)
              : 0
          }
          color={visual.solid}
        />
        <div
          role="cell"
          className="text-right font-mono text-[11.5px] leading-none font-medium tabular-nums"
          style={{ color: sharePercent > 0 ? 'var(--text)' : 'var(--text-tertiary)' }}
        >
          {shareLabel}
        </div>
        <div
          role="cell"
          className="text-right font-mono text-[12.5px] leading-none font-semibold tabular-nums"
          style={{ color: isActive ? visual.text : 'var(--text-tertiary)' }}
        >
          {isActive ? formatSpeed(group.speedBytesPerSec) : '—'}
        </div>
        <div
          role="cell"
          className="pr-5 text-right font-mono text-[11.5px] leading-none text-[var(--text-secondary)] tabular-nums"
        >
          {formatBytes(group.bytesDownloaded)}
        </div>
      </div>

      {expanded &&
        group.chunks.map((chunk, index) => {
          const isFirst = index === 0
          const isLast = index === group.chunks.length - 1
          const isChunkActive = chunk.status === 'downloading'
          const stream = describeStream(chunk, blocks)
          const statusText = stream.done
            ? 'Done'
            : chunk.status === 'paused'
              ? 'Paused'
              : chunk.status === 'retrying'
                ? 'Retrying…'
                : 'Idle'

          return (
            <div
              role="row"
              key={chunk.id}
              className={`${rowClass} border-[var(--border-subtle)] bg-card py-[6px] font-mono text-[11px] leading-[1.2] ${
                isFirst ? 'border-t-[0.5px] pt-[9px]' : ''
              } ${isLast ? 'border-b-[0.5px] pb-[11px]' : ''}`}
            >
              <div role="cell" className="flex justify-center pl-5">
                <div
                  className="size-[5px] rounded-full"
                  style={{
                    background: isChunkActive || stream.done ? visual.solid : 'var(--icon-muted)',
                    opacity: isChunkActive || stream.done ? 1 : 0.4
                  }}
                />
              </div>

              <div role="cell" className="flex min-w-0 items-center gap-[6px]">
                <span className="font-medium whitespace-nowrap text-foreground">
                  Stream #{index + 1}
                </span>
                {stream.block && (
                  <span className="rounded-[3px] border-[0.5px] border-border bg-secondary px-[4.5px] py-[1.5px] font-mono text-[9px] leading-none whitespace-nowrap text-muted-foreground">
                    Chunk #{stream.block.index + 1}
                  </span>
                )}
                {isChunkActive ? (
                  <Tooltip disabled={!chunk.hedge}>
                    <TooltipTrigger
                      render={
                        <ColorBadge
                          bg={visual.bg}
                          border={visual.border}
                          text={visual.text}
                          tabIndex={chunk.hedge ? 0 : undefined}
                          // Height is pinned, not `h-auto`: this badge swaps in and out as a
                          // stream goes active, and the cell is only as tall as "Stream #N"
                          // (13.2px). Left to size itself the badge came out taller than that and
                          // grew the row on every swap. 13px keeps it under, whatever line-height
                          // it ends up inheriting.
                          className="h-[13px] rounded-[3px] px-[5px] py-px text-[9px] font-semibold tracking-[0.04em] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          {chunk.hedge ? 'BACKUP' : 'ACTIVE'}
                        </ColorBadge>
                      }
                    />
                    <TooltipContent>
                      Racing another stream for this chunk, which was running slowly
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span
                    className={`text-[9.5px] ${
                      chunk.status === 'retrying' ? 'text-destructive' : 'text-muted-foreground'
                    }`}
                  >
                    {statusText}
                  </span>
                )}
              </div>

              <ProgressBar
                className="h-[5px]"
                label={`Stream #${index + 1} progress`}
                percent={stream.percent}
                color={visual.solid}
              />

              <div
                role="cell"
                className="text-right font-mono text-[11px] leading-none font-medium tabular-nums"
                style={{
                  color: stream.done
                    ? visual.text
                    : isChunkActive
                      ? 'var(--text)'
                      : 'var(--text-tertiary)'
                }}
              >
                {stream.block || stream.done ? `${Math.round(stream.percent)}%` : '—'}
              </div>

              <div
                role="cell"
                className="text-right font-mono text-[11px] leading-none font-medium tabular-nums"
                style={{ color: isChunkActive ? visual.text : 'var(--text-tertiary)' }}
              >
                {isChunkActive ? formatSpeed(chunk.speedBytesPerSec) : '—'}
              </div>

              <div
                role="cell"
                className="pr-5 text-right font-mono text-[11px] leading-none whitespace-nowrap text-[var(--text-secondary)] tabular-nums"
              >
                {stream.size > 0
                  ? `${formatBytes(stream.downloaded)} / ${formatBytes(stream.size)}`
                  : formatBytes(stream.downloaded)}
              </div>
            </div>
          )
        })}
    </>
  )
}
