import { CircleArrowUp } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Sits next to ThemeToggle once the banner has been dismissed — same size/shape, so it reads as
 * part of the same row of controls rather than a separate alert. */
export function UpdateIndicator(): React.JSX.Element | null {
  const availableUpdate = useAppStore((store) => store.availableUpdate)

  if (!availableUpdate?.dismissed) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          // target="_blank" routes through the main process's window-open handler, which hands
          // http(s) links to the OS browser instead of opening a second app window.
          <a
            href={availableUpdate.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Update available: ${availableUpdate.version}`}
            className="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-[0.5px] border-border bg-secondary text-[var(--text-secondary)] [-webkit-app-region:no-drag]"
          >
            <CircleArrowUp size={15} strokeWidth={1.3} />
          </a>
        }
      />
      <TooltipContent>New update available</TooltipContent>
    </Tooltip>
  )
}
