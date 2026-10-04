import type { HttpBlockState, HttpStreamState, NetworkStatus } from '@shared/types'
import { useState } from 'react'
import { DANGER, type NetworkVisual } from '../theme'
import type { HttpNetworkGroup, NetworkGroup, TorrentNetworkGroup } from '../utils/format'
import { describeError, formatBytes, formatSpeed } from '../utils/format'
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
  blocks?: HttpBlockState[]
  onSwitch: (enabled: boolean) => void
}

const STATUS_TEXT: Record<Exclude<NetworkStatus, 'on'>, string> = {
  off: 'Off',
  offline: 'Not connected',
  unreachable: 'Can’t reach server',
  failed: 'Failed',
  limit: 'Data limit reached'
}

/** What a network that isn't simply on says: here, and in the downloads list's tooltip. */
// eslint-disable-next-line react-refresh/only-export-components -- one wording, shared
export function networkStatusText(
  status: Exclude<NetworkStatus, 'on'>,
  transfer: 'http' | 'torrent'
): string {
  return status === 'unreachable' && transfer === 'torrent'
    ? 'Can’t reach peers'
    : STATUS_TEXT[status]
}

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

function streamProgress(
  stream: HttpStreamState,
  blocks?: HttpBlockState[]
): {
  block: HttpBlockState | undefined
  done: boolean
  size: number
  downloaded: number
  percent: number
} {
  const block = stream.currentBlockIndex == null ? undefined : blocks?.[stream.currentBlockIndex]
  const done = stream.status === 'completed' || block?.status === 'completed'
  const size = block?.rangeEnd == null ? 0 : block.rangeEnd - block.rangeStart + 1
  const downloaded = block?.bytesDownloaded ?? stream.bytesDownloaded
  return {
    block,
    done,
    size,
    downloaded,
    percent: done ? 100 : size > 0 ? Math.min(100, (downloaded / size) * 100) : 0
  }
}

function HttpStreamRows({
  group,
  visual,
  blocks
}: {
  group: HttpNetworkGroup
  visual: NetworkVisual
  blocks?: HttpBlockState[]
}): React.JSX.Element {
  return (
    <>
      {group.streams.map((stream, index) => {
        const progress = streamProgress(stream, blocks)
        const active = stream.status === 'downloading'
        const status = progress.done
          ? 'Done'
          : stream.status === 'paused'
            ? 'Paused'
            : stream.status === 'retrying'
              ? 'Retrying…'
              : 'Idle'
        return (
          <div
            role="row"
            key={stream.id}
            className={`${rowClass} border-[var(--border-subtle)] bg-card py-[6px] font-mono text-[11px] leading-[1.2] ${index === 0 ? 'border-t-[0.5px] pt-[9px]' : ''} ${index === group.streams.length - 1 ? 'border-b-[0.5px] pb-[11px]' : ''}`}
          >
            <div role="cell" className="flex justify-center pl-5">
              <div
                className="size-[5px] rounded-full"
                style={{
                  background: active || progress.done ? visual.solid : 'var(--icon-muted)',
                  opacity: active || progress.done ? 1 : 0.4
                }}
              />
            </div>
            <div role="cell" className="flex min-w-0 items-center gap-[6px]">
              <span className="font-medium whitespace-nowrap text-foreground">
                Stream #{index + 1}
              </span>
              {progress.block && (
                <span className="rounded-[3px] border-[0.5px] border-border bg-secondary px-[4.5px] py-[1.5px] text-[9px] leading-none whitespace-nowrap text-muted-foreground">
                  Chunk #{progress.block.index + 1}
                </span>
              )}
              {/* A lit dot and a speed say it's fetching; only what isn't the usual gets a word. */}
              {active && stream.hedge ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <ColorBadge
                        bg={visual.bg}
                        border={visual.border}
                        text={visual.text}
                        tabIndex={0}
                        className="h-[13px] rounded-[3px] px-[5px] py-px text-[9px] font-semibold tracking-[0.04em] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        BACKUP
                      </ColorBadge>
                    }
                  />
                  <TooltipContent>
                    Racing another stream for this chunk, which was running slowly
                  </TooltipContent>
                </Tooltip>
              ) : (
                !active && (
                  <span
                    className={`text-[9.5px] ${stream.status === 'retrying' ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {status}
                  </span>
                )
              )}
            </div>
            <ProgressBar
              className="h-[5px]"
              label={`Stream #${index + 1} progress`}
              percent={progress.percent}
              color={visual.solid}
            />
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-none font-medium tabular-nums"
              style={{
                color: progress.done ? visual.text : active ? 'var(--text)' : 'var(--text-tertiary)'
              }}
            >
              {shareOf(stream.bytesDownloaded, group.bytesDownloaded)}
            </div>
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-none font-medium whitespace-nowrap tabular-nums"
              style={{ color: active ? visual.text : 'var(--text-tertiary)' }}
            >
              {active ? formatSpeed(stream.speedBytesPerSec) : '—'}
            </div>
            <div
              role="cell"
              className="pr-5 text-right font-mono text-[11px] leading-none whitespace-nowrap text-[var(--text-secondary)] tabular-nums"
            >
              {formatBytes(stream.bytesDownloaded)}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** A share as the table shows it: 0% for nothing, <1% for a sliver, never past 100%. */
function shareOf(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) return '0%'
  const percent = Math.min(100, Math.round((part / whole) * 100))
  return percent === 0 ? '<1%' : `${percent}%`
}

/** Download, and upload once there is any: the arrows only when both are shown. */
function TwoWay({
  down,
  up,
  showUp,
  labels
}: {
  down: string
  up: string
  showUp: boolean
  labels: [string, string]
}): React.JSX.Element {
  return (
    <>
      <div>
        <span className="sr-only">{labels[0]} </span>
        {showUp && <span aria-hidden>↓ </span>}
        {down}
      </div>
      {showUp && (
        <div className="text-muted-foreground">
          <span className="sr-only">{labels[1]} </span>
          <span aria-hidden>↑ </span>
          {up}
        </div>
      )}
    </>
  )
}

function PeerRows({
  group,
  visual
}: {
  group: TorrentNetworkGroup
  visual: NetworkVisual
}): React.JSX.Element {
  // What the network's peers have sent between them: each one's share of it.
  const received = group.peers.reduce((sum, peer) => sum + peer.bytesDownloaded, 0)
  return (
    <>
      {group.peers.map((peer, index) => {
        const receiving = peer.status === 'receiving' && peer.speedBytesPerSec > 0
        const sent = peer.bytesUploaded > 0
        return (
          <div
            role="row"
            key={peer.id}
            className={`${rowClass} border-[var(--border-subtle)] bg-card py-[6px] font-mono text-[11px] leading-[1.2] ${index === 0 ? 'border-t-[0.5px] pt-[9px]' : ''} ${index === group.peers.length - 1 ? 'border-b-[0.5px] pb-[11px]' : ''}`}
          >
            <div role="cell" className="flex justify-center pl-5">
              {/* Its state, with its speed: no word needed beside it. */}
              <div
                role="img"
                aria-label={receiving ? 'Receiving' : 'Idle'}
                className="size-[5px] rounded-full"
                style={{
                  background: receiving ? visual.solid : 'var(--icon-muted)',
                  opacity: receiving ? 1 : 0.4
                }}
              />
            </div>
            <div role="cell" className="flex min-w-0 items-center gap-[6px]">
              <span className="font-medium whitespace-nowrap text-foreground">
                {/* Unique in the download: a number is never another peer's, here or on
                    another network. */}
                Peer #{peer.id + 1}
              </span>
              {/* The client it runs, as a stream shows its chunk. */}
              {peer.client && (
                <span className="min-w-0 truncate rounded-[3px] border-[0.5px] border-border bg-secondary px-[4.5px] py-[1.5px] text-[9px] leading-none whitespace-nowrap text-muted-foreground">
                  {peer.client}
                </span>
              )}
            </div>
            {/* A peer has no progress of its own: a piece counts once verified, and several
                peers may send parts of one. */}
            <div role="cell" className="text-muted-foreground">
              —
            </div>
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-none font-medium tabular-nums"
              style={{ color: receiving ? 'var(--text)' : 'var(--text-tertiary)' }}
            >
              {shareOf(peer.bytesDownloaded, received)}
            </div>
            <div
              role="cell"
              className="text-right font-mono text-[11px] leading-[1.35] font-medium whitespace-nowrap tabular-nums"
              style={{ color: receiving ? visual.text : 'var(--text-tertiary)' }}
            >
              <TwoWay
                down={receiving ? formatSpeed(peer.speedBytesPerSec) : '—'}
                up={
                  peer.uploadSpeedBytesPerSec > 0 ? formatSpeed(peer.uploadSpeedBytesPerSec) : '—'
                }
                showUp={sent}
                labels={['Receiving at', 'Sending at']}
              />
            </div>
            <div
              role="cell"
              className="pr-5 text-right font-mono text-[11px] leading-[1.35] whitespace-nowrap text-[var(--text-secondary)] tabular-nums"
            >
              <TwoWay
                down={formatBytes(peer.bytesDownloaded)}
                up={formatBytes(peer.bytesUploaded)}
                showUp={sent}
                labels={['Received', 'Sent']}
              />
            </div>
          </div>
        )
      })}
    </>
  )
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
  const connections = group.transfer === 'http' ? group.streams : group.peers
  const isActive =
    group.transfer === 'http'
      ? group.streams.some((stream) => stream.status === 'downloading')
      : group.peers.some((peer) => peer.status === 'receiving')
  const hasError = group.status === 'failed'
  const rounded = Math.round(sharePercent)
  const shareLabel = group.bytesDownloaded === 0 ? '0%' : rounded === 0 ? '<1%' : `${rounded}%`
  const noun = group.transfer === 'http' ? 'stream' : 'peer'
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
          <Checkbox
            checked={group.enabled}
            onCheckedChange={(checked) => onSwitch(checked)}
            aria-label={`Use ${visual.name}`}
            className="shrink-0 data-checked:border-transparent"
            style={group.enabled ? { background: visual.solid, color: visual.onSolid } : undefined}
          />
          <TruncatedText
            text={visual.name}
            className={`font-sans text-[12.5px] leading-[1.2] font-semibold ${group.enabled ? 'text-foreground' : 'text-[var(--text-secondary)]'}`}
          />
          <NetworkEditPopover
            interfaceId={group.id}
            interfaceKind={group.kind}
            osName={group.label}
          />
          {connections.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              className="h-auto cursor-pointer rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)] aria-expanded:bg-secondary dark:bg-card"
            >
              {connections.length} {noun}
              {connections.length === 1 ? '' : 's'}{' '}
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
                    className={`rounded-sm font-mono text-[10px] whitespace-nowrap outline-none ${hasError ? 'text-destructive' : 'text-muted-foreground'}`}
                  >
                    {networkStatusText(group.status, group.transfer)}
                  </span>
                }
              />
              <TooltipContent>{group.error && describeError(group.error)}</TooltipContent>
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
          className="text-right font-mono text-[11px] leading-[1.35] font-semibold whitespace-nowrap tabular-nums"
          style={{ color: isActive ? visual.text : 'var(--text-tertiary)' }}
        >
          <TwoWay
            down={isActive ? formatSpeed(group.speedBytesPerSec) : '—'}
            // Like down: a dash while nothing is going out. Each direction is idle on its own.
            up={
              group.transfer === 'torrent' && group.uploadSpeedBytesPerSec > 0
                ? formatSpeed(group.uploadSpeedBytesPerSec)
                : '—'
            }
            // Always for a torrent, so it's plain each network uploads too.
            showUp={group.transfer === 'torrent'}
            labels={['Downloading at', 'Uploading at']}
          />
        </div>
        <div
          role="cell"
          className="pr-5 text-right font-mono text-[11.5px] leading-[1.35] text-[var(--text-secondary)] tabular-nums"
        >
          <TwoWay
            down={formatBytes(group.bytesDownloaded)}
            up={formatBytes(group.transfer === 'torrent' ? group.bytesUploaded : 0)}
            showUp={group.transfer === 'torrent'}
            labels={['Downloaded', 'Uploaded']}
          />
        </div>
      </div>
      {expanded &&
        (group.transfer === 'http' ? (
          <HttpStreamRows group={group} visual={visual} blocks={blocks} />
        ) : (
          <PeerRows group={group} visual={visual} />
        ))}
    </>
  )
}
