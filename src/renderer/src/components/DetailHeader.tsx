import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  headerActions,
  isFinished,
  manageActions,
  type ActionId,
  type DownloadItem
} from '../utils/downloadActions'
import { useDownloadActions, useDownloadActionsState } from './downloadActionsContext'
import { ACTION_META } from './downloadActionMeta'
import { Button } from './ui/button'

/** The top of a download's own screen, laid out as the list's header is: the way back to the
 * list on the left; on the right the ways out (Cancel while it's unfinished; Remove, and Move to
 * Trash, after) and what the download can do next. They're what its row and its menu offer, from the same list. */
export function DetailHeader({ download }: { download: DownloadItem }): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const { perform } = useDownloadActions()
  const { busy } = useDownloadActionsState()
  const manage = manageActions(download)
  const next = headerActions(download)

  // Resuming round-trips through the main process to re-verify the download before its status
  // flips (an ETag re-check over the network for a real download). With no feedback in between,
  // a slow check reads as the button not having registered the click: it says so until the
  // download's state moves on.
  const state = isFinished(download) ? 'finished' : `${download.status}|${download.error ?? ''}`
  const [working, setWorking] = useState<{ id: ActionId; state: string } | null>(null)

  const run = (id: ActionId): void => {
    if (id === 'pause' || id === 'resume' || id === 'retry') setWorking({ id, state })
    void perform(id, [download]).catch(() => setWorking(null))
  }

  const button = (
    id: ActionId,
    variant: 'default' | 'secondary' | 'destructive'
  ): React.ReactNode => {
    const meta = ACTION_META[id]
    const isWorking = working?.id === id && working.state === state
    return (
      <Button
        key={id}
        type="button"
        variant={variant}
        disabled={isWorking || (busy && manage.includes(id))}
        onClick={() => run(id)}
      >
        {isWorking && meta.working ? meta.working : meta.label}
      </Button>
    )
  }

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-border px-5">
      <button
        type="button"
        onClick={() => setView({ name: 'list' })}
        className="-ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
      >
        <ChevronLeft className="size-4.5" />
        Downloads
      </button>
      <div className="flex-1" />
      {manage.map((id) => button(id, ACTION_META[id].destructive ? 'destructive' : 'secondary'))}
      {next.map((id, index) =>
        // The last is the main one; Pause is never the main one, it's the way to stop.
        button(id, index === next.length - 1 && id !== 'pause' ? 'default' : 'secondary')
      )}
    </div>
  )
}
