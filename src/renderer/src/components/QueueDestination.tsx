import { cn } from 'cn'
import { useAppStore } from '../store/useAppStore'
import { toDisplayPath } from '../utils/format'
import { Button } from './ui/button'

/** The queue's folder, which every item is saved to, and a way to pick another. */
export function QueueDestination({ className }: { className?: string }): React.JSX.Element {
  const destinationDir = useAppStore((store) => store.queue?.destinationDir)
  const homeDir = useAppStore((store) => store.homeDir)

  const handleBrowse = async (): Promise<void> => {
    if (destinationDir === undefined) return
    const chosen = await window.plexo.chooseDestinationFolder(destinationDir)
    if (chosen) await window.plexo.queueCommand({ kind: 'setDestination', dir: chosen })
  }

  return (
    <div
      className={cn(
        'flex h-8 items-center gap-[9px] rounded-[8px] border-[0.5px] border-border px-2.5',
        className
      )}
    >
      <div className="shrink-0 font-mono text-[10px] leading-none tracking-[0.14em] text-muted-foreground uppercase">
        Save to
      </div>
      <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-secondary)]">
        {destinationDir ? toDisplayPath(destinationDir, homeDir) : ''}
      </div>
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={handleBrowse}
        className="h-auto shrink-0 px-0 font-mono text-[11px]"
      >
        Browse…
      </Button>
    </div>
  )
}
