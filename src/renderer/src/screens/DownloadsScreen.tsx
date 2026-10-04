import type { DownloadState, FinishedDownload } from '@shared/types'
import { ChevronRight, Pause, Play, Plus, RotateCw, X, type LucideIcon } from 'lucide-react'
import { cn } from 'cn'
import { memo, useCallback, useEffect, useState } from 'react'
import { DownloadFilterMenu } from '../components/DownloadFilterMenu'
import { CombineDiagram } from '../components/CombineDiagram'
import { FixLinkDialog } from '../components/FixLinkDialog'
import { LimitsDialog } from '../components/LimitsDialog'
import { NetworksMenu } from '../components/NetworksMenu'
import { TorrentBadge } from '../components/TorrentBadge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../components/ui/alert-dialog'
import { Button, buttonVariants } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { useNetworkVisuals, type ResolveNetworkVisual } from '../hooks/useNetworkVisuals'
import { useAppStore, type DownloadFilter } from '../store/useAppStore'
import {
  describeError,
  fileExtensionBadge,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  formatWhen,
  isFolder,
  linkExpired,
  sourceOf,
  wantedBytes
} from '../utils/format'

type Item = DownloadState | FinishedDownload

interface Group {
  label: string
  items: Item[]
}

function filterOf(item: Item): Exclude<DownloadFilter, 'all'> {
  if ('unitsWritten' in item || item.status === 'completed') return 'finished'
  return item.status === 'error' ? 'failed' : 'progress'
}

const isFinished = (item: Item): item is FinishedDownload => 'unitsWritten' in item

function groupsOf(downloads: DownloadState[], history: FinishedDownload[]): Group[] {
  const byStatus = (status: DownloadState['status']): DownloadState[] =>
    downloads.filter((download) => download.status === status)
  return [
    { label: 'Downloading', items: byStatus('downloading') },
    {
      label: 'Queued',
      items: byStatus('queued').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
    },
    { label: 'Paused', items: byStatus('paused') },
    { label: 'Needs attention', items: byStatus('error') },
    // Completed but not in history yet: on its way there, so listed with it.
    { label: 'Finished', items: [...byStatus('completed'), ...history] }
  ].filter((group) => group.items.length > 0)
}

/** "2 downloading · 1 queued", or "all done". */
function summaryOf(downloads: DownloadState[]): string {
  const count = (status: DownloadState['status']): number =>
    downloads.filter((download) => download.status === status).length
  const parts = [
    [count('downloading'), 'downloading'],
    [count('queued'), 'queued'],
    [count('paused'), 'paused'],
    [count('error'), 'need attention']
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, label]) => `${n} ${label}`)
  return parts.length > 0 ? parts.join(' · ') : 'all done'
}

const groupLabelClass =
  'font-mono text-[10.5px] leading-none font-medium tracking-[0.18em] text-muted-foreground uppercase'

export function DownloadsScreen(): React.JSX.Element {
  const downloadsById = useAppStore((store) => store.downloads)
  const history = useAppStore((store) => store.history)
  const setView = useAppStore((store) => store.setView)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const removeDownload = useAppStore((store) => store.removeDownload)
  const filter = useAppStore((store) => store.downloadFilter)
  const setFilter = useAppStore((store) => store.setDownloadFilter)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fixing, setFixing] = useState<DownloadState | null>(null)
  const [confirmation, setConfirmation] = useState<{
    kind: 'cancel' | 'trash'
    ids: string[]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [limitsPage, setLimitsPage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const downloads = Object.values(downloadsById)
    .filter((download) => download.status !== 'cancelled')
    .sort((a, b) => a.startedAt - b.startedAt)
  const allGroups = groupsOf(downloads, history)
  const allItems = allGroups.flatMap((group) => group.items)
  const counts: Record<DownloadFilter, number> = {
    all: allItems.length,
    progress: 0,
    finished: 0,
    failed: 0
  }
  for (const item of allItems) counts[filterOf(item)]++
  const groups = allGroups.filter(
    (group) => filter === 'all' || filterOf(group.items[0]) === filter
  )
  const items = groups.flatMap((group) => group.items)
  // Only what's still listed counts: one that finished or went is no longer selected.
  const chosen = items.filter((item) => selected.has(item.id))

  const toggle = useCallback(
    (ids: string[], on: boolean): void =>
      setSelected((previous) => {
        const next = new Set(previous)
        for (const id of ids) {
          if (on) next.add(id)
          else next.delete(id)
        }
        return next
      }),
    []
  )
  // Stable, with the colors resolved once here, so a finished row skips every progress push.
  const networkVisual = useNetworkVisuals()
  const selectRow = useCallback((id: string, on: boolean) => toggle([id], on), [toggle])
  const openRow = useCallback((id: string) => setView({ name: 'download', id }), [setView])
  const fixRow = useCallback((item: Item) => {
    if (!isFinished(item)) setFixing(item)
  }, [])
  const againRow = useCallback(
    (item: Item) => {
      removeDownload(item.id)
      openNewDownload(item.url)
    },
    [removeDownload, openNewDownload]
  )

  const pausable = chosen.filter(
    (item): item is DownloadState =>
      !isFinished(item) && (item.status === 'downloading' || item.status === 'queued')
  )
  const resumable = chosen.filter(
    (item): item is DownloadState => !isFinished(item) && item.status === 'paused'
  )
  const retryable = chosen.filter(
    (item): item is DownloadState =>
      !isFinished(item) && item.status === 'error' && item.resumable !== false && !linkExpired(item)
  )
  const unfinished = chosen.filter((item) => !isFinished(item) && item.status !== 'completed')
  const finished = chosen.filter((item) => isFinished(item) || item.status === 'completed')
  const trashable = finished.filter(
    (item) =>
      !(isFinished(item) && item.missing) &&
      (item.kind !== 'torrent' ||
        !item.folder ||
        !isFinished(item) ||
        !!item.downloadedFiles?.length)
  )
  const confirmationItems = confirmation
    ? chosen.filter(
        (item) =>
          confirmation.ids.includes(item.id) &&
          (confirmation.kind === 'cancel' ? unfinished.includes(item) : trashable.includes(item))
      )
    : []

  const runAction = async (
    targets: Item[],
    action: 'pause' | 'resume' | 'remove' | 'trash'
  ): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      for (const item of targets) {
        if (action === 'pause') await window.plexo.pauseDownload(item.id)
        else if (action === 'resume') await window.plexo.resumeDownload(item.id)
        else {
          await window.plexo.removeDownload(item.id, { trashFile: action === 'trash' })
          useAppStore.setState((store) => {
            const { [item.id]: removed, ...downloads } = store.downloads
            void removed
            return { downloads, history: store.history.filter((entry) => entry.id !== item.id) }
          })
          setSelected((previous) => {
            const next = new Set(previous)
            next.delete(item.id)
            return next
          })
        }
      }
    } catch (error) {
      setActionError(describeError(error))
    } finally {
      setBusy(false)
      setConfirmation(null)
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {chosen.length === 0 ? (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5">
          <DownloadFilterMenu
            value={filter}
            counts={counts}
            onChange={(next) => {
              setFilter(next)
              setSelected(new Set())
            }}
          />
          {/* One group already says it in its header. */}
          {allGroups.length > 1 && (
            <div className="font-mono text-[11.5px] leading-none text-muted-foreground">
              {summaryOf(downloads)}
            </div>
          )}
          <div className="flex-1" />
          <NetworksMenu
            onOpenLimits={(page) => {
              setLimitsPage(page)
              setLimitsOpen(true)
            }}
          />
          <Button type="button" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
          </Button>
        </div>
      ) : (
        <div
          role="toolbar"
          aria-label="Selected downloads"
          aria-busy={busy}
          className="flex h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-border px-5"
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Deselect all"
                  disabled={busy}
                  onClick={() => setSelected(new Set())}
                >
                  <X />
                </Button>
              }
            />
            <TooltipContent>Deselect all</TooltipContent>
          </Tooltip>
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold">
            {chosen.length} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || chosen.length === items.length}
            onClick={() => setSelected(new Set(items.map((item) => item.id)))}
          >
            Select all
          </Button>
          <div className="flex-1" />
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {pausable.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void runAction(pausable, 'pause')}
              >
                Pause ({pausable.length})
              </Button>
            )}
            {resumable.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void runAction(resumable, 'resume')}
              >
                Resume ({resumable.length})
              </Button>
            )}
            {retryable.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void runAction(retryable, 'resume')}
              >
                Retry ({retryable.length})
              </Button>
            )}
            {finished.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void runAction(finished, 'remove')}
              >
                Remove from list ({finished.length})
              </Button>
            )}
            {unfinished.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  setConfirmation({ kind: 'cancel', ids: unfinished.map((item) => item.id) })
                }
              >
                Cancel downloads… ({unfinished.length})
              </Button>
            )}
            {trashable.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  setConfirmation({ kind: 'trash', ids: trashable.map((item) => item.id) })
                }
              >
                Move files to {window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'}… (
                {trashable.length})
              </Button>
            )}
          </div>
        </div>
      )}
      {actionError && (
        <div role="alert" className="border-b border-border px-5 py-2 text-[12px] text-destructive">
          {actionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {groups.length === 0 &&
          (filter === 'all' ? (
            <EmptyState />
          ) : (
            <div role="status" className="flex flex-col items-center gap-2 px-5 py-16 text-center">
              <p className="text-[16px] font-semibold">
                {filter === 'progress'
                  ? 'No downloads in progress'
                  : filter === 'finished'
                    ? 'No finished downloads'
                    : 'No downloads need attention'}
              </p>
              <Button type="button" variant="secondary" onClick={() => setFilter('all')}>
                Show all downloads
              </Button>
            </div>
          ))}
        {groups.map((group) => {
          const ids = group.items.map((item) => item.id)
          const all = ids.every((id) => selected.has(id))
          const some = !all && ids.some((id) => selected.has(id))
          return (
            <section key={group.label} aria-label={group.label}>
              <div className="group/group-header flex items-center gap-3 border-b-[0.5px] border-border pt-5 pb-3">
                <Checkbox
                  className={cn(
                    chosen.length === 0 &&
                      'opacity-0 group-focus-within/group-header:opacity-100 group-hover/group-header:opacity-100'
                  )}
                  aria-label={
                    group.label === 'Needs attention'
                      ? 'Select all downloads needing attention'
                      : `Select all ${group.label.toLowerCase()} downloads`
                  }
                  checked={all}
                  indeterminate={some}
                  onCheckedChange={(on) => toggle(ids, on)}
                />
                <h2 className={groupLabelClass}>
                  {group.label}
                  <span className="ml-2.5 tracking-normal">{group.items.length}</span>
                </h2>
                <div className="flex-1" />
                {group.label === 'Finished' && history.length > 0 && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="text-[12.5px] text-[var(--text-secondary)] hover:text-foreground"
                          onClick={() => void window.plexo.clearHistory()}
                        >
                          Clear finished list
                        </button>
                      }
                    />
                    <TooltipContent>Downloaded files stay on your computer</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {group.items.map((item) => (
                <DownloadRow
                  key={item.id}
                  item={item}
                  now={now}
                  selected={selected.has(item.id)}
                  selecting={chosen.length > 0}
                  networkVisual={
                    isFinished(item) || item.status === 'completed' ? undefined : networkVisual
                  }
                  onSelect={selectRow}
                  onOpen={openRow}
                  onFix={fixRow}
                  onAgain={againRow}
                />
              ))}
            </section>
          )
        })}
      </div>

      <FixLinkDialog download={fixing} onClose={() => setFixing(null)} />
      <LimitsDialog
        open={limitsOpen}
        onOpenChange={setLimitsOpen}
        page={limitsPage}
        onPageChange={setLimitsPage}
      />

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmation?.kind === 'cancel'
                ? 'Cancel'
                : `Move files to ${window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'} for`}{' '}
              {confirmationItems.length} {confirmationItems.length === 1 ? 'download' : 'downloads'}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.kind === 'cancel'
                ? 'This stops the selected unfinished downloads and deletes their downloaded data. Finished downloads stay unchanged.'
                : `This moves the selected finished downloads’ files to the ${window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'} and removes them from the list. Unrelated files stay in place.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || confirmationItems.length === 0}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
              onClick={() =>
                void runAction(
                  confirmationItems,
                  confirmation?.kind === 'cancel' ? 'remove' : 'trash'
                )
              }
            >
              {confirmation?.kind === 'cancel'
                ? 'Cancel downloads'
                : `Move files to ${window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// Colors are irrelevant here — the diagram is rendered `muted`, which overrides them all to
// var(--icon-muted) — these are just three placeholder rows to draw the illustration with.
const PLACEHOLDER_NETWORKS = [
  { solid: 'var(--icon-muted)', label: 'Wi-Fi' },
  { solid: 'var(--icon-muted)', label: 'USB' },
  { solid: 'var(--icon-muted)', label: 'Ethernet' }
]
const PASTE_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
const NEW_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘N' : 'Ctrl+N'

/** Nothing listed yet: how to start one — or, with no network connected, how to get one. */
function EmptyState(): React.JSX.Element {
  const noNetworks = useAppStore(
    (store) => store.interfacesStatus === 'ready' && store.interfaces.length === 0
  )
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  return (
    <div className="flex flex-col items-center gap-4 px-5 pt-16 pb-10 text-center">
      <CombineDiagram networks={PLACEHOLDER_NETWORKS} muted />
      {noNetworks ? (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">No networks connected</div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            Plexo needs at least one active network. Join a Wi-Fi network, plug in Ethernet, or
            connect your phone using USB tethering.
          </div>
          <div className="mt-1 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
              Scan again
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => window.plexo.openNetworkSettings()}
            >
              Network settings…
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="font-sans text-[16px] leading-[1.2] font-bold">No downloads yet</div>
          <div className="max-w-[380px] text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
            Paste a link ({PASTE_SHORTCUT}) or drop a .torrent anywhere in this window.
          </div>
          <Button type="button" className="mt-1" onClick={() => openNewDownload()}>
            <Plus data-icon="inline-start" />
            New download
            <span className="ml-1 font-mono text-[11px] opacity-70">{NEW_SHORTCUT}</span>
          </Button>
        </>
      )}
    </div>
  )
}

const DownloadRow = memo(function DownloadRow({
  item,
  now,
  selected,
  selecting,
  networkVisual,
  onSelect,
  onOpen,
  onFix,
  onAgain
}: {
  item: Item
  now: number
  selected: boolean
  /** Something is selected: every checkbox shows, not just the hovered row's. */
  selecting: boolean
  /** Colors its progress bar; a finished row has none. */
  networkVisual?: ResolveNetworkVisual
  onSelect: (id: string, on: boolean) => void
  onOpen: (id: string) => void
  onFix: (item: Item) => void
  onAgain: (item: Item) => void
}): React.JSX.Element {
  const finished = isFinished(item) || item.status === 'completed'
  const badge = isFolder(item) ? 'DIR' : fileExtensionBadge(item.fileName)
  const wanted = wantedBytes(item)
  const percent = formatPercent(item.bytesDownloaded, wanted)

  let detail: string
  let tone = 'text-muted-foreground'
  let action: { label: string; run: () => void; icon?: LucideIcon } | null = null
  if (isFinished(item) || item.status === 'completed') {
    detail = [
      formatBytes(wanted || item.bytesDownloaded),
      // A torrent's badge already says where it came from.
      item.kind === 'http' && sourceOf(item.url),
      isFinished(item) && item.missing
        ? 'moved or deleted'
        : formatWhen(item.completedAt ?? now, now)
    ]
      .filter(Boolean)
      .join(' · ')
  } else {
    const download = item
    const sizes =
      wanted > 0
        ? `${formatBytes(download.bytesDownloaded)} of ${formatBytes(wanted)}`
        : formatBytes(download.bytesDownloaded)
    switch (download.status) {
      case 'downloading':
        detail = [
          wanted > 0 && `${percent}%`,
          sizes,
          formatSpeed(download.speedBytesPerSec),
          download.timeLeftSeconds !== undefined && formatEta(download.timeLeftSeconds)
        ]
          .filter(Boolean)
          .join(' · ')
        action = {
          label: 'Pause',
          icon: Pause,
          run: () => void window.plexo.pauseDownload(download.id)
        }
        break
      case 'queued':
        detail = `Waiting for a turn · ${sizes}`
        action = {
          label: 'Pause',
          icon: Pause,
          run: () => void window.plexo.pauseDownload(download.id)
        }
        break
      case 'paused':
        detail = wanted > 0 ? `Paused at ${percent}% · ${sizes}` : `Paused · ${sizes}`
        action = {
          label: 'Resume',
          icon: Play,
          run: () => void window.plexo.resumeDownload(download.id)
        }
        break
      default:
        detail = describeError(download.error ?? 'Something went wrong')
        tone = 'text-[var(--color-danger)]'
        if (linkExpired(download)) action = { label: 'Fix link', run: () => onFix(item) }
        else if (download.resumable !== false) {
          action = {
            label: 'Retry',
            icon: RotateCw,
            run: () => void window.plexo.resumeDownload(download.id)
          }
        } else action = { label: 'Download again', run: () => onAgain(item) }
    }
  }

  // The bar shows each network's share of the file in its color; a failed one shows in red.
  const segments =
    finished || isFinished(item) || !networkVisual
      ? []
      : item.status === 'error'
        ? [
            {
              id: 'error',
              share: item.bytesDownloaded / (wanted || 1),
              color: 'var(--color-danger)'
            }
          ]
        : item.networks
            .filter((network) => network.bytesDownloaded > 0)
            .map((network) => ({
              id: network.id,
              share: network.bytesDownloaded / (wanted || 1),
              color: networkVisual(network.id, network.kind, network.label).solid
            }))

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        'group/download-row my-0.5 -mx-2 flex items-center gap-3 rounded-lg px-2 py-3 transition-colors',
        selected
          ? 'bg-primary/10 hover:bg-primary/15 focus-within:bg-primary/15'
          : 'hover:bg-secondary focus-within:bg-secondary'
      )}
    >
      <Checkbox
        className={cn(
          !selecting &&
            !selected &&
            'opacity-0 group-focus-within/download-row:opacity-100 group-hover/download-row:opacity-100'
        )}
        aria-label={`Select ${item.fileName}`}
        checked={selected}
        onCheckedChange={(on) => onSelect(item.id, on)}
      />
      <button
        type="button"
        onClick={() => onOpen(item.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border-[0.5px] border-border bg-card font-mono text-[10px] font-semibold text-muted-foreground">
          {badge}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-sans text-[14px] leading-tight font-medium">
              {item.fileName}
            </span>
            {item.kind === 'torrent' && <TorrentBadge />}
          </div>
          {segments.length > 0 && (
            <div
              className={cn(
                'flex h-1 overflow-hidden rounded-full bg-muted',
                // Not moving: the colors stay, faded, so it doesn't read as running.
                !isFinished(item) &&
                  (item.status === 'paused' || item.status === 'queued') &&
                  'opacity-40'
              )}
            >
              {segments.map((segment) => (
                <div
                  key={segment.id}
                  style={{
                    width: `${Math.min(100, segment.share * 100)}%`,
                    background: segment.color
                  }}
                />
              ))}
            </div>
          )}
          <div className={`truncate font-mono text-[11.5px] leading-tight ${tone}`}>{detail}</div>
        </div>
      </button>
      {action?.icon ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={`${action.label} ${item.fileName}`}
                onClick={action.run}
                className="text-muted-foreground group-hover/download-row:text-foreground"
              >
                <action.icon />
              </Button>
            }
          />
          <TooltipContent>{action.label}</TooltipContent>
        </Tooltip>
      ) : (
        action && (
          <Button type="button" size="sm" variant="secondary" onClick={action.run}>
            {action.label}
          </Button>
        )
      )}
      <button
        type="button"
        aria-label={`Open ${item.fileName}`}
        onClick={() => onOpen(item.id)}
        className="rounded-md p-1 text-muted-foreground transition-colors group-hover/download-row:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
})
