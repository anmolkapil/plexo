import type { LimitLine } from '../utils/limitedBy'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** The one line under a download's total speed that says what holds it back (see
 * utils/limitedBy.ts), and, for a limit the user set, a way to change it. The dialog is the
 * screen's, so a reason that changes while it's open doesn't close it. As wide as the speed
 * above it and no wider (w-0 min-w-full): a long reason wraps rather than pushing the chart
 * aside, so the band doesn't move when one comes or goes. */
export function LimitNote({
  line,
  onOpenLimits
}: {
  line: LimitLine
  onOpenLimits: (page: string | null) => void
}): React.JSX.Element {
  const { limits } = line
  return (
    <div
      role="status"
      aria-label="What limits the speed"
      className="mt-0.5 flex w-0 min-w-full flex-wrap items-baseline gap-x-1.5 font-sans text-[11px] leading-[1.3] font-medium text-[var(--text-secondary)]"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {line.text}
            </span>
          }
        />
        <TooltipContent>{line.detail}</TooltipContent>
      </Tooltip>
      {limits && (
        <button
          type="button"
          onClick={() => onOpenLimits(limits.page)}
          className="rounded-sm text-foreground underline decoration-[0.5px] underline-offset-2 outline-none hover:decoration-1 focus-visible:ring-2 focus-visible:ring-ring"
        >
          Change
        </button>
      )}
    </div>
  )
}
