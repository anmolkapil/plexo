import { isFailure } from '@shared/queueItem'
import { cn } from 'cn'
import { ListOrdered } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Opens the queue; once there is one, also says how far through it is ("3/22"), whether it's
 * moving (a glowing dot, as the title bar's own status uses) and whether anything failed. */
export function QueueButton(): React.JSX.Element {
  const queue = useAppStore((store) => store.queue)
  const open = useAppStore((store) => store.queueOpen)
  const setOpen = useAppStore((store) => store.setQueueOpen)

  const items = queue?.items ?? []
  const total = items.length
  const done = items.filter((item) => item.status === 'completed').length
  const failed = items.filter(isFailure).length
  const moving = items.some((item) => item.status === 'active' || item.status === 'starting')
  const label =
    total === 0
      ? 'Queue'
      : `Queue: ${done} of ${total} done${failed > 0 ? `, ${failed} failed` : ''}`

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={cn(
              'flex h-[26px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[6px] border-[0.5px] border-border bg-secondary text-[var(--text-secondary)] transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [-webkit-app-region:no-drag]',
              total > 0 ? 'px-2' : 'w-[26px]',
              open && 'border-[var(--border-strong)] text-foreground'
            )}
          >
            <ListOrdered size={15} strokeWidth={1.3} aria-hidden="true" />
            {total > 0 && (
              <span
                // Re-keyed on each change so the count gives a small bump when it moves.
                key={`${done}/${total}`}
                className="animate-[plexo-bump_320ms_ease-out] font-mono text-[10.5px] leading-none font-semibold tabular-nums"
              >
                {done}/{total}
              </span>
            )}
            {(moving || failed > 0) && (
              <span
                aria-hidden="true"
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  failed > 0 && !moving
                    ? 'bg-[var(--color-danger)]'
                    : 'animate-[plexo-glow_2s_ease-in-out_infinite] bg-[var(--color-accent)]'
                )}
              />
            )}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
