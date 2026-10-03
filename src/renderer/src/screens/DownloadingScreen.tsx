import type { DownloadState } from '@shared/types'
import { Folder } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { BlockGrid } from '../components/BlockGrid'
import { ColorBadge } from '../components/ColorBadge'
import { CombineDiagram } from '../components/CombineDiagram'
import { CyclableChip } from '../components/CyclableChip'
import { HeroBand } from '../components/HeroBand'
import { NetworkRow } from '../components/NetworkRow'
import { DetailHeader } from '../components/DetailHeader'
import { ThroughputChart } from '../components/ThroughputChart'
import { TorrentFiles } from '../components/TorrentFiles'
import { TorrentBadge } from '../components/TorrentBadge'
import { TruncatedText } from '../components/TruncatedText'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { KIND_PALETTE, NETWORK_ROW_GRID_COLUMNS } from '../theme'
import {
  describeError,
  describeFileCount,
  dirnameOf,
  fileExtensionBadge,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  groupByNetwork,
  isFolder,
  networksInPlay,
  splitFormattedBytes,
  toDisplayPath,
  wantedBytes
} from '../utils/format'

/** Inline "·" separator between adjacent stats. `shrink` pins it at its natural width inside a
 * flex row that might otherwise squeeze it (footer rows), matching each call site's prior style. */
function Dot(): React.JSX.Element {
  return <span className="opacity-35">·</span>
}

function InlineStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span>
      {label} <span className="font-semibold text-foreground">{value}</span>
    </span>
  )
}

/** The hero band's headline figure: a tracked-out label over one big tabular number and its unit. */
function BigStat({
  label,
  value,
  unit,
  valueClass
}: {
  label: string
  value: string | number
  unit?: string
  valueClass: string
}): React.JSX.Element {
  return (
    <>
      <div className="font-mono text-[10px] leading-none font-medium tracking-[0.2em] text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-[7px]">
        <div
          className={`font-mono text-[38px] leading-[0.88] font-semibold tracking-[-0.03em] tabular-nums ${valueClass}`}
        >
          {value}
        </div>
        {unit && (
          <div className="font-mono text-[12px] leading-none font-medium text-muted-foreground">
            {unit}
          </div>
        )}
      </div>
    </>
  )
}

/** What the download is waiting on, when no network is carrying it. */
function waitingFor(download: DownloadState): string | null {
  if (download.status !== 'downloading') return null
  const enabled = download.networks.filter((network) => network.enabled)
  if (enabled.some((network) => network.status === 'on')) return null
  if (enabled.some((network) => network.status === 'unreachable')) {
    return download.kind === 'torrent'
      ? 'Can’t reach peers. Retrying…'
      : 'Can’t reach the server. Retrying…'
  }
  return enabled.length > 0 && enabled.every((network) => network.status === 'limit')
    ? 'Every network in use has reached its data limit. Raise one in Speed & data limits.'
    : 'Waiting for a network. Reconnect one or switch one on.'
}

// Memoized: App re-renders on every download's progress, and this one's grid and tables are
// the heaviest thing on screen. Its download keeps its object until its own update arrives.
export const DownloadingScreen = memo(function DownloadingScreen({
  download
}: {
  download: DownloadState
}): React.JSX.Element {
  const homeDir = useAppStore((store) => store.homeDir)
  const speedHistory = download.speedHistory ?? {}
  const peakSpeedBytesPerSec = download.peakSpeedBytesPerSec
  const networkVisual = useNetworkVisuals()
  const isQueued = download.status === 'queued'
  // Waiting in the queue looks like a pause: nothing moves.
  const isPaused = download.status === 'paused' || isQueued
  const isTorrent = download.kind === 'torrent'
  const percent = formatPercent(download.bytesDownloaded, wantedBytes(download))
  const knownSize = download.totalBytes > 0
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (isPaused) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [isPaused])

  // Resuming round-trips through the main process to re-verify the download before flipping
  // status away from 'paused' (an ETag re-check over the network for a real download) — with no
  // feedback in between, a slow check reads as the button not having registered the click.
  const [resuming, setResuming] = useState(false)
  const [filesOpen, setFilesOpen] = useState(false)
  useEffect(() => {
    if (!isPaused || download.error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResuming(false)
    }
  }, [isPaused, download.error])

  useEffect(() => {
    if (isPaused) {
      const label = isQueued ? 'Queued' : 'Paused'
      document.title = knownSize ? `Plexo — ${label} (${percent}%)` : `Plexo — ${label}`
    } else {
      document.title = knownSize ? `Plexo — ${percent}%` : 'Plexo — downloading'
    }
    return () => {
      document.title = 'Plexo'
    }
  }, [percent, knownSize, isPaused, isQueued])

  const totalPausedMs =
    (download.totalPausedMs || 0) +
    (isPaused && download.pausedAt ? Math.max(0, now - download.pausedAt) : 0)
  const elapsedSeconds = Math.max(0, (now - download.startedAt - totalPausedMs) / 1000)

  const handlePauseResume = (): void => {
    // A queued one is paused out of the queue, as a running one is.
    if (isPaused && !isQueued) {
      setResuming(true)
      void window.plexo.resumeDownload(download.id)
    } else {
      void window.plexo.pauseDownload(download.id)
    }
  }

  const effectiveSpeed = isPaused ? 0 : download.speedBytesPerSec
  const speed = splitFormattedBytes(effectiveSpeed)
  // Every network is a row, for switching it on or off; the charts draw only those in play.
  const rows = groupByNetwork(download)
  const rowVisuals = rows.map((row) => networkVisual(row.id, row.kind, row.label))
  const groups = networksInPlay(rows)
  const visuals = groups.map((group) => networkVisual(group.id, group.kind, group.label))
  const totalDownloadedByNetworks = rows.reduce((sum, row) => sum + row.bytesDownloaded, 0)
  const [chipModeIndex, setChipModeIndex] = useState(0)
  const waiting = waitingFor(download)

  const totalRetries = rows.reduce((sum, row) => sum + row.retries, 0)
  const remainingBytes = knownSize
    ? Math.max(0, wantedBytes(download) - download.bytesDownloaded)
    : 0

  const avgSpeedBytesPerSec = elapsedSeconds > 0 ? download.bytesDownloaded / elapsedSeconds : 0

  // "N× WIFI ALONE": the combined download measured against one network on its own, by whichever
  // metric is live — current speed while bytes are moving, total downloaded otherwise. A network
  // that carried the download barely faster than it would alone (< 1.05×) makes no point worth a
  // chip. Cycling order is fastest network (smallest multiple) first, as it was.
  const bySpeed = download.speedBytesPerSec > 0
  const totalMetric = bySpeed ? download.speedBytesPerSec : download.bytesDownloaded
  const chipOptions =
    groups.length > 1 && !isPaused && totalMetric > 0
      ? groups
          .map((group, index) => ({
            ratio: totalMetric / (bySpeed ? group.speedBytesPerSec : group.bytesDownloaded),
            visual: visuals[index]
          }))
          .filter(({ ratio }) => Number.isFinite(ratio) && ratio >= 1.05)
          .sort((a, b) => a.ratio - b.ratio)
          .map(({ ratio, visual }) => ({
            visual,
            label: `${ratio.toFixed(1)}× ${visual.name.toUpperCase()} ALONE`,
            tooltip: bySpeed
              ? `Total speed is ${ratio.toFixed(1)}× faster than ${visual.name} alone`
              : `Total downloaded is ${ratio.toFixed(1)}× compared to ${visual.name} alone`
          }))
      : []

  const activeChipOption =
    chipOptions.length > 0 ? chipOptions[chipModeIndex % chipOptions.length] : null

  const statusBadge = isPaused
    ? { label: isQueued ? 'QUEUED' : 'PAUSED', palette: KIND_PALETTE.usb }
    : null

  const throughputStatusLabel = isPaused
    ? null
    : `LAST ${Object.values(speedHistory)[0]?.length ?? 0}S`
  const pauseResumeLabel = resuming ? 'Resuming…' : isPaused && !isQueued ? 'Resume' : 'Pause'

  return (
    <div className="flex h-full flex-col bg-background">
      <DetailHeader download={download}>
        <Button
          type="button"
          variant={isPaused && !isQueued ? 'default' : 'secondary'}
          onClick={handlePauseResume}
          disabled={resuming}
        >
          {pauseResumeLabel}
        </Button>
      </DetailHeader>
      {/* Hero band — always visible under the header */}
      <HeroBand>
        <div className="flex items-center gap-[14px]">
          <CombineDiagram
            networks={groups.map((group, index) => ({
              solid: visuals[index].solid,
              label: visuals[index].name,
              speedBytesPerSec: isPaused ? 0 : group.speedBytesPerSec
            }))}
            paused={isPaused}
          />

          <div className="flex min-w-[130px] shrink-0 flex-col gap-[7px]">
            <>
              <BigStat
                label="TOTAL SPEED"
                value={isPaused ? '—' : speed.value}
                unit={isPaused ? undefined : `${speed.unit}/s`}
                valueClass={isPaused ? 'text-muted-foreground' : 'text-foreground'}
              />
              <div className="flex items-center gap-2 font-mono text-[10px] leading-none font-medium tabular-nums text-muted-foreground">
                <InlineStat label="AVG" value={formatSpeed(avgSpeedBytesPerSec)} />
                <Dot />
                {/* A dash until a speed has been held long enough to call it the peak. */}
                <InlineStat
                  label="PEAK"
                  value={
                    peakSpeedBytesPerSec === undefined ? '—' : formatSpeed(peakSpeedBytesPerSec)
                  }
                />
              </div>
              {isPaused || waiting
                ? (download.error || waiting) && (
                    <div
                      role="alert"
                      className="mt-0.5 font-sans text-[11px] leading-[1.2] font-medium text-destructive"
                    >
                      {download.error ? describeError(download.error) : waiting}
                    </div>
                  )
                : activeChipOption && (
                    <CyclableChip
                      label={activeChipOption.label}
                      tooltip={`${activeChipOption.tooltip}${chipOptions.length > 1 ? ' (click to toggle)' : ''}`}
                      bg={activeChipOption.visual.bg}
                      border={activeChipOption.visual.border}
                      color={activeChipOption.visual.text}
                      cyclable={chipOptions.length > 1}
                      onClick={() => setChipModeIndex((i) => (i + 1) % chipOptions.length)}
                    />
                  )}
            </>
          </div>

          <div
            className={`min-w-0 flex-1 transition-opacity duration-200 ${
              isPaused ? 'opacity-45' : 'opacity-100'
            }`}
          >
            <div className="font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] text-muted-foreground">
              THROUGHPUT{throughputStatusLabel ? ` · ${throughputStatusLabel}` : ''}
            </div>
            <ThroughputChart
              order={groups.map((g, i) => ({
                interfaceId: g.id,
                solid: visuals[i].solid
              }))}
              historyByInterface={speedHistory}
            />
          </div>
        </div>
      </HeroBand>

      {/* File info — always visible, never shrinks */}
      <div className="shrink-0 p-[16px_20px_0px]">
        <div className="flex items-center gap-[14px]">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border-[0.5px] border-[var(--border-strong)] bg-card font-mono text-[10.5px] leading-none font-bold tracking-[0.04em] text-[var(--text-secondary)]">
            {isFolder(download) ? (
              <Folder aria-label="Folder" className="size-[18px]" />
            ) : (
              fileExtensionBadge(download.fileName)
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <TruncatedText
                text={download.fileName}
                className="font-sans text-[15px] leading-[1.3] font-semibold tracking-[-0.01em] text-foreground"
              />
              {isTorrent && <TorrentBadge />}
            </div>
            <div className="flex min-w-0 items-center gap-[7px] font-mono text-[12.5px] leading-[1.2] tabular-nums text-[var(--text-secondary)]">
              <span>
                {formatBytes(download.bytesDownloaded)}
                {knownSize ? ` of ${formatBytes(wantedBytes(download))}` : ''}
              </span>
              {knownSize && (
                <>
                  <Dot />
                  <span className="font-semibold text-foreground">{percent}%</span>
                </>
              )}
              {isTorrent && (
                <>
                  <Dot />
                  <span>
                    {download.peers.length} {download.peers.length === 1 ? 'peer' : 'peers'}
                  </span>
                </>
              )}
              {/* Several files: they open below. One is the name above. */}
              {download.kind === 'torrent' && download.files.total > 1 && (
                <>
                  <Dot />
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => setFilesOpen((open) => !open)}
                    aria-expanded={filesOpen}
                    className="h-auto cursor-pointer rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)] aria-expanded:bg-secondary dark:bg-card"
                  >
                    {describeFileCount(download.files.chosen, download.files.total)}{' '}
                    <span aria-hidden className="text-[7.5px] opacity-75">
                      {filesOpen ? '▲' : '▼'}
                    </span>
                  </Button>
                </>
              )}
              {!isPaused && knownSize && effectiveSpeed > 0 && (
                <>
                  <Dot />
                  <span className="text-[var(--text-secondary)]">
                    {formatEta(remainingBytes, effectiveSpeed)} left
                  </span>
                </>
              )}
              {statusBadge && (
                <ColorBadge
                  bg={statusBadge.palette.bg}
                  border={statusBadge.palette.border}
                  text={statusBadge.palette.text}
                  // Pinned for the same reason as the stream row's ACTIVE badge: sizing itself,
                  // it pushed this text block past the 44px file-type icon beside it and nudged
                  // everything below down. At h-4 the block stays under the icon, so the row
                  // height is the icon's either way.
                  className="h-4 rounded-[3.5px] px-[7px] py-0.5 text-[9.5px] font-semibold tracking-[0.08em]"
                >
                  {statusBadge.label}
                </ColorBadge>
              )}
              {totalRetries > 0 && (
                <>
                  <Dot />
                  <span className="text-[var(--color-usb)]">
                    {totalRetries} {totalRetries === 1 ? 'retry' : 'retries'}
                  </span>
                </>
              )}
              {/* Last and to the right: the one part that gives way when the line runs short. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="ml-auto flex min-w-0 items-center gap-1.5 pl-3 text-[11px] text-muted-foreground">
                      <Folder aria-hidden className="size-3 shrink-0" />
                      <span className="sr-only">Saving to</span>
                      <span className="truncate">
                        {toDisplayPath(dirnameOf(download.destinationPath), homeDir)}
                      </span>
                    </span>
                  }
                />
                <TooltipContent>Saving to: {download.destinationPath}</TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>
        {download.kind === 'torrent' && filesOpen && (
          <TorrentFiles downloadId={download.id} pieces={download.pieces} />
        )}
      </div>

      {/* Block grid: pinned with the file info. It's capped in height and scrolls itself. */}
      <div className="shrink-0 px-5 pt-3">
        <BlockGrid
          blocks={download.kind === 'http' ? download.blocks : download.pieces}
          groups={groups}
          visuals={visuals}
          knownSize={knownSize}
          remainingBytes={remainingBytes}
          isPaused={isPaused}
          pieces={isTorrent}
        />
      </div>

      {/* Network table: only its rows scroll, under their column headers. Edge to edge: its rows
          pad themselves. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <div className="mt-3">
          <div
            role="table"
            aria-label="Networks"
            className="grid gap-x-3"
            style={{ gridTemplateColumns: NETWORK_ROW_GRID_COLUMNS }}
          >
            <div
              role="row"
              className="sticky top-0 z-10 col-span-full grid grid-cols-subgrid gap-x-3 border-b border-border bg-background pt-2.5 pb-[7px] font-mono text-[9.5px] leading-none tracking-[0.12em] text-muted-foreground uppercase"
            >
              <div role="columnheader" aria-label="Status" />
              <div role="columnheader">Network</div>
              <div role="columnheader">
                {isTorrent ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="rounded-sm text-inherit uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          Progress
                        </button>
                      }
                    />
                    <TooltipContent>
                      Percentage of the download completed with verified data from this network.
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  'Progress'
                )}
              </div>
              <div role="columnheader" className="text-right">
                Share
              </div>
              <div role="columnheader" className="text-right">
                Speed
              </div>
              <div role="columnheader" className="pr-5 text-right">
                {isTorrent ? 'Transferred' : 'Downloaded'}
              </div>
            </div>
            {rows.map((row, index) => (
              <NetworkRow
                key={row.id}
                group={row}
                visual={rowVisuals[index]}
                sharePercent={
                  totalDownloadedByNetworks > 0
                    ? (row.bytesDownloaded / totalDownloadedByNetworks) * 100
                    : 0
                }
                totalBytes={wantedBytes(download)}
                blocks={download.kind === 'http' ? download.blocks : undefined}
                onSwitch={(enabled) =>
                  void window.plexo.setDownloadNetwork(download.id, row.id, enabled)
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
})
