import { isCancelled, isFailure, nameOf } from '@shared/queueItem'
import type { DownloadState, QueueItem, QueueState } from '@shared/types'
import { cn } from 'cn'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Link2Off,
  ListPlus,
  Loader2,
  Minus,
  Pause,
  Play,
  RotateCw,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatBytes, formatEta, formatSpeed, toDisplayPath } from '../utils/format'
import { FileNameText } from './FileNameText'
import { QueueDestination } from './QueueDestination'
import { Button } from './ui/button'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from './ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

function command(command: Parameters<typeof window.plexo.queueCommand>[0]): void {
  void window.plexo.queueCommand(command).catch(() => {})
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** The one thing an icon button does, said on hover and to a screen reader. */
function IconAction({
  label,
  onClick,
  children,
  disabled
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="text-muted-foreground hover:text-foreground"
          >
            {children}
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A small ring filling up with the download: the list's version of the main screen's bar. */
function ProgressRing({
  fraction,
  paused
}: {
  fraction: number
  paused: boolean
}): React.JSX.Element {
  const radius = 8.5
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 22 22" className="size-[22px] -rotate-90" aria-hidden="true">
      <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--track-bg)" strokeWidth="2.5" />
      <circle
        cx="11"
        cy="11"
        r={radius}
        fill="none"
        stroke={paused ? 'var(--color-neutral)' : 'var(--color-accent)'}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, fraction)))}
        className="transition-[stroke-dashoffset] duration-500 ease-out"
      />
    </svg>
  )
}

function StatusGlyph({
  item,
  position,
  live
}: {
  item: QueueItem
  position: number
  live: DownloadState | null
}): React.JSX.Element {
  const circle = 'flex size-[22px] shrink-0 items-center justify-center rounded-full'
  switch (item.status) {
    case 'queued':
      return (
        <div
          className={cn(
            circle,
            'border-[0.5px] border-[var(--border-strong)] bg-card font-mono text-[9.5px] font-semibold tabular-nums text-[var(--text-secondary)]'
          )}
        >
          {position}
        </div>
      )
    case 'starting':
      return (
        <div className={cn(circle, 'text-[var(--color-accent)]')}>
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        </div>
      )
    case 'active': {
      const total = live?.totalBytes || item.totalBytes || 0
      const done = live?.bytesDownloaded ?? item.bytesDownloaded ?? 0
      return (
        <div className={cn(circle, 'relative')}>
          <ProgressRing
            fraction={total > 0 ? done / total : 0}
            paused={live?.status === 'paused'}
          />
          {live?.status === 'paused' && (
            <Pause className="absolute size-2.5 fill-current text-[var(--color-neutral)]" />
          )}
        </div>
      )
    }
    case 'completed':
      return (
        <div
          className={cn(
            circle,
            'border-[0.5px] border-[var(--color-wifi-border)] bg-[var(--color-wifi-bg)] text-[var(--color-wifi)]'
          )}
        >
          <Check className="size-3" strokeWidth={3} aria-hidden="true" />
        </div>
      )
    case 'failed':
      if (item.problem === 'expired') {
        return (
          <div
            className={cn(
              circle,
              'border-[0.5px] border-[var(--color-usb-border)] bg-[var(--color-usb-bg)] text-[var(--color-usb-text)]'
            )}
          >
            <Link2Off className="size-3" strokeWidth={2.4} aria-hidden="true" />
          </div>
        )
      }
      if (item.problem === 'cancelled') {
        return (
          <div
            className={cn(
              circle,
              'border-[0.5px] border-[var(--color-neutral-border)] bg-[var(--color-neutral-bg)] text-[var(--color-neutral-text)]'
            )}
          >
            <Minus className="size-3" strokeWidth={3} aria-hidden="true" />
          </div>
        )
      }
      return (
        <div
          className={cn(
            circle,
            'border-[0.5px] border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-destructive'
          )}
        >
          <AlertTriangle className="size-3" strokeWidth={2.4} aria-hidden="true" />
        </div>
      )
  }
}

/** How much of a waiting or failed item is already on disk, for its retry to pick up from. */
function kept(item: QueueItem): string | null {
  if (!item.downloadId || !item.bytesDownloaded) return null
  return item.totalBytes
    ? `${Math.min(99, Math.floor((item.bytesDownloaded / item.totalBytes) * 100))}% kept`
    : `${formatBytes(item.bytesDownloaded)} kept`
}

/** The line under an item's name: where it's at, in a few words. */
function statusLine(item: QueueItem, live: DownloadState | null): React.ReactNode {
  const size = item.totalBytes ? formatBytes(item.totalBytes) : null
  switch (item.status) {
    case 'queued': {
      const parts = [item.retryAt ? 'Retrying shortly' : 'Waiting']
      if (size) parts.push(size)
      const progress = kept(item)
      if (progress) parts.push(progress)
      const host = hostOf(item.url)
      if (host) parts.push(host)
      return parts.join(' · ')
    }
    case 'starting':
      return 'Checking the link…'
    case 'active': {
      const total = live?.totalBytes || item.totalBytes || 0
      const done = live?.bytesDownloaded ?? item.bytesDownloaded ?? 0
      const percent = total > 0 ? `${Math.min(100, Math.floor((done / total) * 100))}%` : null
      if (live?.status === 'paused') {
        return ['Paused', percent ?? formatBytes(done)].join(' · ')
      }
      const speed = live?.speedBytesPerSec ?? 0
      return [
        percent ?? formatBytes(done),
        speed > 0 ? formatSpeed(speed) : 'Connecting…',
        total > 0 && speed > 0 ? `${formatEta(total - done, speed)} left` : null
      ]
        .filter(Boolean)
        .join(' · ')
    }
    case 'completed':
      return [size, 'Saved'].filter(Boolean).join(' · ')
    case 'failed':
      return [kept(item), item.error ?? 'Failed'].filter(Boolean).join(' · ')
  }
}

function QueueRow({
  item,
  position,
  waitingCount,
  live,
  homeDir
}: {
  item: QueueItem
  /** Its place among the waiting items, from 1; 0 if it isn't waiting. */
  position: number
  waitingCount: number
  live: DownloadState | null
  homeDir: string
}): React.JSX.Element {
  const expired = item.status === 'failed' && item.problem === 'expired'
  // Failed or cancelled: either can be retried; only a failure reads as an error.
  const failed = item.status === 'failed'
  const total = live?.totalBytes || item.totalBytes || 0
  const done = live?.bytesDownloaded ?? item.bytesDownloaded ?? 0
  const name = nameOf(item)

  return (
    <li
      className={cn(
        'group relative flex animate-[plexo-row-in_220ms_ease-out] items-start gap-3 border-b-[0.5px] border-[var(--border-subtle)] px-4 py-[11px] transition-colors duration-150 hover:bg-card',
        item.status === 'active' && 'bg-card'
      )}
    >
      <div className="pt-px">
        <StatusGlyph item={item} position={position} live={live} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <FileNameText
            name={name}
            tooltipText={item.destinationPath ? toDisplayPath(item.destinationPath, homeDir) : name}
            className="min-w-0 font-sans text-[12.5px] font-semibold text-foreground"
          />
        </div>
        <div
          className={cn(
            'mt-[3px] font-mono text-[10.5px] leading-[1.45] tabular-nums',
            isFailure(item)
              ? expired
                ? 'line-clamp-3 text-[var(--color-usb-text)]'
                : 'line-clamp-3 text-destructive'
              : 'truncate text-muted-foreground'
          )}
        >
          {statusLine(item, live)}
        </div>
        {(item.status === 'active' || item.status === 'starting') && (
          <div className="mt-[7px] h-[3px] overflow-hidden rounded-full bg-muted">
            {item.status === 'starting' || total === 0 ? (
              <div className="h-full w-2/5 animate-[plexo-indeterminate_1.4s_ease-in-out_infinite] rounded-full bg-[var(--color-accent)] opacity-70" />
            ) : (
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-500 ease-out',
                  live?.status === 'paused'
                    ? 'bg-[var(--color-neutral)]'
                    : 'bg-[var(--color-accent)]'
                )}
                style={{ width: `${Math.min(100, (done / total) * 100)}%` }}
              />
            )}
          </div>
        )}
      </div>
      {/* Actions show on hover or keyboard focus, so a long list stays quiet to read. */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        {item.status === 'queued' && (
          <>
            <IconAction
              label="Move up"
              disabled={position <= 1}
              onClick={() => command({ kind: 'move', id: item.id, offset: -1 })}
            >
              <ChevronUp />
            </IconAction>
            <IconAction
              label="Move down"
              disabled={position >= waitingCount}
              onClick={() => command({ kind: 'move', id: item.id, offset: 1 })}
            >
              <ChevronDown />
            </IconAction>
          </>
        )}
        {failed && (
          <IconAction label="Retry" onClick={() => command({ kind: 'retry', id: item.id })}>
            <RotateCw />
          </IconAction>
        )}
        {item.status === 'completed' && item.destinationPath && (
          <IconAction
            label={window.plexo.platform === 'darwin' ? 'Reveal in Finder' : 'Show in folder'}
            onClick={() => void window.plexo.revealInFolder(item.destinationPath!)}
          >
            <FolderOpen />
          </IconAction>
        )}
        {item.status !== 'active' && item.status !== 'starting' && (
          <IconAction
            label={item.status === 'completed' ? 'Remove from list' : 'Remove'}
            onClick={() => command({ kind: 'remove', id: item.id })}
          >
            <X />
          </IconAction>
        )}
      </div>
    </li>
  )
}

/** Something the queue is waiting on, or can't do, said above the list. */
function QueueNotice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      role="status"
      className="mt-2.5 flex animate-[plexo-row-in_200ms_ease-out] gap-2 rounded-[8px] border-[0.5px] border-[var(--color-usb-border)] bg-[var(--color-usb-bg)] px-2.5 py-2 font-sans text-[11.5px] leading-[1.45] text-[var(--color-usb-text)]"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

function Summary({ queue }: { queue: QueueState }): React.JSX.Element {
  const count = (status: QueueItem['status']): number =>
    queue.items.filter((item) => item.status === status).length
  const done = count('completed')
  const failed = queue.items.filter(isFailure).length
  const cancelled = queue.items.filter(isCancelled).length
  const waiting = count('queued') + count('starting') + count('active')
  const leftBytes = queue.items
    .filter((item) => item.status !== 'completed' && item.status !== 'failed')
    .reduce(
      (sum, item) => sum + Math.max(0, (item.totalBytes ?? 0) - (item.bytesDownloaded ?? 0)),
      0
    )
  const parts = [`${done} done`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (cancelled > 0) parts.push(`${cancelled} cancelled`)
  parts.push(`${waiting} to go`)
  if (leftBytes > 0) parts.push(`${formatBytes(leftBytes)} left`)
  return (
    <div className="mt-[7px] font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
      {parts.join(' · ')}
    </div>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-1 animate-[plexo-row-in_260ms_ease-out] flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border-[0.5px] border-[var(--border-strong)] bg-card text-[var(--text-secondary)]">
        <ListPlus className="size-5" strokeWidth={1.6} aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="font-sans text-[14px] font-semibold text-foreground">Nothing queued</div>
        <p className="font-sans text-[12px] leading-[1.5] text-[var(--text-secondary)]">
          Paste several links at once. Files download one after another, each over every network.
        </p>
      </div>
      <Button type="button" size="sm" onClick={onAdd}>
        <ListPlus data-icon="inline-start" />
        Add links
      </Button>
    </div>
  )
}

export function QueueSheet(): React.JSX.Element {
  const queue = useAppStore((store) => store.queue)
  const open = useAppStore((store) => store.queueOpen)
  const setOpen = useAppStore((store) => store.setQueueOpen)
  const openAddLinks = useAppStore((store) => store.openAddLinks)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const homeDir = useAppStore((store) => store.homeDir)

  const items = queue?.items ?? []
  const failed = items.filter(isFailure).length
  // Done with, and cleared by Clear: saved, or cancelled.
  const finished = items.filter((item) => item.status === 'completed' || isCancelled(item)).length
  const pending = items.some((item) => item.status === 'queued' || item.status === 'active')
  const running = queue?.running ?? false
  const activeItem = items.find((item) => item.status === 'active')
  const activePaused =
    !!activeItem &&
    currentDownload?.id === activeItem.downloadId &&
    currentDownload?.status === 'paused'
  // A download started from the start screen: not one of the queue's, which waits for it. (One
  // the queue is starting shows up here a moment before its item says it's its own.)
  const outside =
    (currentDownload?.status === 'downloading' || currentDownload?.status === 'paused') &&
    !items.some((item) => item.downloadId === currentDownload.id || item.status === 'starting')
      ? currentDownload
      : null
  // Each waiting item's place in line, counting waiting items only.
  const positions = new Map<string, number>()
  for (const item of items) {
    if (item.status === 'queued') positions.set(item.id, positions.size + 1)
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent aria-describedby={undefined}>
        <div className="shrink-0 border-b-[0.5px] border-border px-4 pt-3.5 pb-3">
          <div className="flex items-center gap-2">
            <SheetTitle className="font-sans text-[15px] leading-none font-bold tracking-[-0.01em]">
              Queue
            </SheetTitle>
            <SheetDescription className="sr-only">
              Links waiting to download, one after another.
            </SheetDescription>
            <div className="flex-1" />
            <SheetClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close queue"
                  className="-mr-1.5 text-muted-foreground"
                />
              }
            >
              <X />
            </SheetClose>
          </div>
          {queue && items.length > 0 && <Summary queue={queue} />}

          <div className="mt-3 flex items-center gap-1.5">
            {running && (pending || activeItem) && !activePaused ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => command({ kind: 'stop' })}
              >
                <Pause data-icon="inline-start" />
                Pause queue
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!pending}
                onClick={() => command({ kind: 'start' })}
              >
                <Play data-icon="inline-start" />
                {activeItem || finished + failed > 0 ? 'Resume queue' : 'Start queue'}
              </Button>
            )}
            <Button type="button" size="sm" variant="secondary" onClick={() => openAddLinks()}>
              <ListPlus data-icon="inline-start" />
              Add links
            </Button>
            <div className="flex-1" />
            {failed > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => command({ kind: 'retryFailed' })}
                    >
                      <RotateCw data-icon="inline-start" />
                      Retry
                    </Button>
                  }
                />
                <TooltipContent>Retry every failed download</TooltipContent>
              </Tooltip>
            )}
            {finished > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="-mr-1.5 text-muted-foreground"
                      onClick={() => command({ kind: 'clearFinished' })}
                    >
                      Clear
                    </Button>
                  }
                />
                <TooltipContent>Clear finished downloads from the list</TooltipContent>
              </Tooltip>
            )}
          </div>

          <QueueDestination className="mt-2.5" />

          {queue?.loadError && <QueueNotice>{queue.loadError}</QueueNotice>}
          {outside && (
            <QueueNotice>
              {outside.fileName} is downloading on its own, outside the queue.{' '}
              {pending
                ? 'The queue carries on once it’s done.'
                : 'Its progress is on the main screen.'}
            </QueueNotice>
          )}
          {queue?.waitingForNetwork && (
            <QueueNotice>
              No network is connected. The queue carries on as soon as one is.
            </QueueNotice>
          )}
          {queue?.stoppedBecause && <QueueNotice>{queue.stoppedBecause}</QueueNotice>}
          {queue?.blocked && (
            <QueueNotice>
              Your current download failed. Resume it, or start a new download, and the queue
              carries on.
            </QueueNotice>
          )}
        </div>

        {items.length === 0 ? (
          <EmptyState onAdd={() => openAddLinks()} />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Queued downloads">
            {items.map((item) => {
              return (
                <QueueRow
                  key={item.id}
                  item={item}
                  waitingCount={positions.size}
                  position={positions.get(item.id) ?? 0}
                  live={
                    item.status === 'active' && currentDownload?.id === item.downloadId
                      ? currentDownload
                      : null
                  }
                  homeDir={homeDir}
                />
              )
            })}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  )
}
