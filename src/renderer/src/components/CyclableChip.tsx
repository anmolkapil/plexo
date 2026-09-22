import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** A small pill that cycles through a set of comparison stats on click (e.g. "1.4x WIFI ALONE"
 * -> "+40% VS WIFI"), used by CompleteScreen and DownloadingScreen. Shows the ⇄ hint only when
 * there's actually more than one option to cycle to. */
export function CyclableChip({
  label,
  tooltip,
  bg,
  border,
  color,
  cyclable,
  onClick
}: {
  label: string
  tooltip: string
  bg: string
  border: string
  color: string
  cyclable: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className="inline-flex min-h-6 w-fit items-center gap-1.5 rounded-[5px] border-[0.5px] px-2.5 py-1 font-mono text-[10.5px] font-semibold whitespace-nowrap select-none"
            style={{
              background: bg,
              borderColor: border,
              color,
              cursor: cyclable ? 'pointer' : 'default'
            }}
          >
            <span>{label}</span>
            {cyclable && <span className="text-[8.5px] opacity-55">⇄</span>}
          </button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
