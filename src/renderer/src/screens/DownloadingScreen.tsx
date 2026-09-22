import type { DownloadState } from '@shared/types'
import { useEffect, useState } from 'react'
import { BlockGrid } from '../components/BlockGrid'
import { ColorBadge } from '../components/ColorBadge'
import { CombineDiagram } from '../components/CombineDiagram'
import { CyclableChip } from '../components/CyclableChip'
import { HeroBand } from '../components/HeroBand'
import { NetworkRow } from '../components/NetworkRow'
import { ScreenFooter } from '../components/ScreenFooter'
import { ThroughputChart } from '../components/ThroughputChart'
import { TruncatedText } from '../components/TruncatedText'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '../components/ui/alert-dialog'
import { Button, buttonVariants } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useNetworkPolling } from '../hooks/useNetworkPolling'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { KIND_PALETTE, NETWORK_ROW_GRID_COLUMNS } from '../theme'
import {
  dirnameOf,
  fileExtensionBadge,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  groupChunksByInterface,
  splitFormattedBytes,
  toDisplayPath
} from '../utils/format'

/** Inline "·" separator between adjacent stats. `shrink` pins it at its natural width inside a
 * flex row that might otherwise squeeze it (footer rows), matching each call site's prior style. */
function Dot({ shrink }: { shrink?: boolean }): React.JSX.Element {
  return <span className={`opacity-35 ${shrink ? 'shrink-0' : ''}`}>·</span>
}

function InlineStat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span>
      {label} <span className="font-semibold text-foreground">{value}</span>
    </span>
  )
}

/** The hero band's headline figure: a tracked-out label over one big tabular number and its unit.
 * Both states of the band (total speed, assembly progress) are this same shape. */
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

/** Says why a footer action is unavailable, and only while it is — a tooltip on a button you can
 * actually press has nothing to explain. */
function WhileAssembling({
  active,
  text,
  children
}: {
  active: boolean
  text: string
  children: React.ReactElement
}): React.JSX.Element {
  return (
    <Tooltip open={active ? undefined : false}>
      <TooltipTrigger render={children} />
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

export function DownloadingScreen({ download }: { download: DownloadState }): React.JSX.Element {
  useNetworkPolling(true)

  const homeDir = useAppStore((store) => store.homeDir)
  const speedHistory = useAppStore((store) => store.speedHistory)
  const speedHistoryByInterface = useAppStore((store) => store.speedHistoryByInterface)
  const peakSpeedBytesPerSec = useAppStore((store) => store.peakSpeedBytesPerSec)
  const networkVisual = useNetworkVisuals()
  const isPaused = download.status === 'paused'
  const isAssembling = download.status === 'assembling'
  const percent = formatPercent(download.bytesDownloaded, download.totalBytes)
  const assembledBytes = download.assembledBytes ?? 0
  const assemblePercent = formatPercent(assembledBytes, download.totalBytes)
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
  useEffect(() => {
    if (!isPaused || download.error) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResuming(false)
    }
  }, [isPaused, download.error])

  useEffect(() => {
    if (isAssembling) {
      document.title = `Plexo — Assembling (${assemblePercent}%)`
    } else if (isPaused) {
      document.title = knownSize ? `Plexo — Paused (${percent}%)` : 'Plexo — Paused'
    } else {
      document.title = knownSize ? `Plexo — ${percent}%` : 'Plexo — downloading'
    }
    return () => {
      document.title = 'Plexo'
    }
  }, [percent, assemblePercent, knownSize, isPaused, isAssembling])

  const totalPausedMs =
    (download.totalPausedMs || 0) +
    (isPaused && download.pausedAt ? Math.max(0, now - download.pausedAt) : 0)
  const elapsedSeconds = Math.max(0, (now - download.startedAt - totalPausedMs) / 1000)

  const handlePauseResume = (): void => {
    if (isPaused) {
      setResuming(true)
      void window.plexo.resumeDownload(download.id)
    } else {
      void window.plexo.pauseDownload(download.id)
    }
  }
  const handleConfirmCancel = (): void => {
    void window.plexo.cancelDownload(download.id)
  }

  const effectiveSpeed = isPaused ? 0 : download.speedBytesPerSec
  const speed = splitFormattedBytes(effectiveSpeed)
  const groups = groupChunksByInterface(download.chunks)
  const totalDownloadedByNetworks = groups.reduce((sum, g) => sum + g.bytesDownloaded, 0)
  const visuals = groups.map((group) =>
    networkVisual(group.interfaceId, group.interfaceKind, group.interfaceLabel)
  )
  const [chipModeIndex, setChipModeIndex] = useState(0)

  const totalRetries = download.chunks.reduce((sum, chunk) => sum + chunk.retryCount, 0)
  const remainingBytes = knownSize ? Math.max(0, download.totalBytes - download.bytesDownloaded) : 0

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

  const statusBadge = isAssembling
    ? { label: 'ASSEMBLING', palette: KIND_PALETTE.ethernet }
    : isPaused
      ? { label: 'PAUSED', palette: KIND_PALETTE.usb }
      : null

  const throughputStatusLabel = isAssembling
    ? 'ASSEMBLING'
    : isPaused
      ? null
      : `LAST ${speedHistory.length}S`
  const pauseResumeLabel = resuming ? 'Resuming…' : isPaused ? 'Resume' : 'Pause'

  return (
    <div className="flex h-full flex-col bg-background">
      <HeroBand>
        <div className="flex items-center gap-[14px]">
          <CombineDiagram
            networks={groups.map((group, index) => ({
              solid: visuals[index].solid,
              label: visuals[index].name,
              speedBytesPerSec: isPaused || isAssembling ? 0 : group.speedBytesPerSec
            }))}
            paused={isPaused}
            assembling={isAssembling}
          />

          <div className="flex min-w-[130px] shrink-0 flex-col gap-[7px]">
            {isAssembling ? (
              <BigStat
                label="ASSEMBLING"
                value={assemblePercent}
                unit="%"
                valueClass="text-[var(--color-ethernet)]"
              />
            ) : (
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
                  <InlineStat label="PEAK" value={formatSpeed(peakSpeedBytesPerSec)} />
                </div>
                {isPaused
                  ? download.error && (
                      <div
                        role="alert"
                        className="mt-0.5 font-sans text-[11px] leading-[1.2] font-medium text-destructive"
                      >
                        {download.error}
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
            )}
          </div>

          <div
            className={`min-w-0 flex-1 transition-opacity duration-200 ${
              isPaused || isAssembling ? 'opacity-45' : 'opacity-100'
            }`}
          >
            <div className="font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] text-muted-foreground">
              THROUGHPUT{throughputStatusLabel ? ` · ${throughputStatusLabel}` : ''}
            </div>
            <ThroughputChart
              order={groups.map((g, i) => ({
                interfaceId: g.interfaceId,
                solid: visuals[i].solid
              }))}
              historyByInterface={speedHistoryByInterface}
            />
          </div>
        </div>
      </HeroBand>

      <div className="flex flex-col gap-3 p-[16px_20px_18px]">
        <div className="flex items-center gap-[14px]">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[10px] border-[0.5px] border-[var(--border-strong)] bg-card font-mono text-[10.5px] leading-none font-bold tracking-[0.04em] text-[var(--text-secondary)]">
            {fileExtensionBadge(download.fileName)}
          </div>
          <div className="min-w-0 flex-1">
            <TruncatedText
              text={download.fileName}
              className="font-sans text-[15px] leading-[1.3] font-semibold tracking-[-0.01em] text-foreground"
            />
            <div className="mt-1 flex items-center gap-[7px] font-mono text-[12.5px] leading-[1.2] tabular-nums text-[var(--text-secondary)]">
              <span>
                {formatBytes(isAssembling ? assembledBytes : download.bytesDownloaded)}
                {knownSize ? ` of ${formatBytes(download.totalBytes)}` : ''}
              </span>
              {knownSize && (
                <>
                  <Dot />
                  <span className="font-semibold text-foreground">
                    {isAssembling ? assemblePercent : percent}%
                  </span>
                </>
              )}
              {!isPaused && !isAssembling && knownSize && effectiveSpeed > 0 && (
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
            </div>
          </div>
        </div>

        <BlockGrid
          blocks={download.blocks}
          groups={groups}
          visuals={visuals}
          knownSize={knownSize}
          remainingBytes={remainingBytes}
          isPaused={isPaused}
          unit={download.kind === 'torrent' ? 'piece' : 'chunk'}
          assembling={isAssembling}
          assembledBytes={assembledBytes}
        />
      </div>

      <div className="flex-1 overflow-x-hidden overflow-y-auto">
        <div
          role="table"
          aria-label="Networks"
          className="grid gap-x-3"
          style={{ gridTemplateColumns: NETWORK_ROW_GRID_COLUMNS }}
        >
          <div
            role="row"
            className="col-span-full grid grid-cols-subgrid gap-x-3 border-b border-border pt-2.5 pb-[7px] font-mono text-[9.5px] leading-none tracking-[0.12em] text-muted-foreground uppercase"
          >
            <div role="columnheader" aria-label="Status" />
            <div role="columnheader">Network</div>
            <div role="columnheader">Progress</div>
            <div role="columnheader" className="text-right">
              Share
            </div>
            <div role="columnheader" className="text-right">
              Speed
            </div>
            <div role="columnheader" className="pr-5 text-right">
              Downloaded
            </div>
          </div>
          {groups.map((group, index) => (
            <NetworkRow
              key={group.interfaceId}
              group={group}
              visual={visuals[index]}
              sharePercent={
                totalDownloadedByNetworks > 0
                  ? (group.bytesDownloaded / totalDownloadedByNetworks) * 100
                  : 0
              }
              totalBytes={download.totalBytes}
              blocks={download.blocks}
            />
          ))}
        </div>
      </div>

      <ScreenFooter>
        <div className="flex min-w-0 flex-1 items-center gap-[7px] overflow-hidden font-mono text-[11px] leading-[1.4] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 whitespace-nowrap">
                  Saving to {toDisplayPath(dirnameOf(download.destinationPath), homeDir)}
                </span>
              }
            />
            <TooltipContent>Saving to: {download.destinationPath}</TooltipContent>
          </Tooltip>
          <Dot shrink />
          <span className="shrink-0">Resumable</span>
          {totalRetries > 0 && (
            <>
              <Dot shrink />
              <span className="shrink-0 text-[var(--color-usb)]">
                {totalRetries} {totalRetries === 1 ? 'retry' : 'retries'}
              </span>
            </>
          )}
        </div>
        <WhileAssembling active={isAssembling} text="Can’t pause while assembling the file">
          <Button
            type="button"
            variant={isPaused ? 'default' : 'secondary'}
            onClick={handlePauseResume}
            disabled={isAssembling || resuming}
            // Disabled natively means unhoverable/unfocusable, which would silence this button's
            // own explanatory tooltip exactly when it's needed — keep it reachable instead.
            focusableWhenDisabled
          >
            {pauseResumeLabel}
          </Button>
        </WhileAssembling>
        <AlertDialog>
          <WhileAssembling active={isAssembling} text="Can’t cancel while assembling the file">
            <AlertDialogTrigger
              render={
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isAssembling}
                  focusableWhenDisabled
                >
                  Cancel
                </Button>
              }
            />
          </WhileAssembling>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel this download?</AlertDialogTitle>
              <AlertDialogDescription>Progress will be lost.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep downloading</AlertDialogCancel>
              <AlertDialogAction
                className={buttonVariants({ variant: 'destructive', size: 'sm' })}
                onClick={handleConfirmCancel}
              >
                Cancel download
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ScreenFooter>
    </div>
  )
}
