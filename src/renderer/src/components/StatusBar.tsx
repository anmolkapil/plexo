import type { SpeedUnit } from '@shared/types'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { formatBytes } from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { ScreenFooter } from './ScreenFooter'
import { ThemeToggle } from './ThemeToggle'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { UpdateIndicator } from './UpdateIndicator'

const FREE_SPACE_POLL_MS = 30_000

/** MB/s or Mbps for every speed in the app; sits with the theme toggle as a view preference. */
function SpeedUnitToggle(): React.JSX.Element {
  const speedUnit = useAppStore((store) => store.speedUnit)
  const setSpeedUnit = useAppStore((store) => store.setSpeedUnit)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ToggleGroup
            aria-label="Speed units"
            value={[speedUnit]}
            onValueChange={(values) => {
              // Clicking the pressed one would unpress it; one unit is always on.
              if (values[0] !== undefined) setSpeedUnit(values[0] as SpeedUnit)
            }}
            size="xs"
            spacing={0.5}
            className="h-[26px] rounded-[6px] border-[0.5px] border-border p-0.5 [-webkit-app-region:no-drag]"
          >
            {(['bytes', 'bits'] as const).map((unit) => (
              <ToggleGroupItem
                key={unit}
                value={unit}
                className="h-full rounded-[4px] px-1.5 font-mono text-[11px] font-medium text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground"
              >
                {unit === 'bytes' ? 'MB/s' : 'Mbps'}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />
      <TooltipContent>Speed units</TooltipContent>
    </Tooltip>
  )
}

/** Along the bottom of every screen: the room left where downloads are saved, the queue, the
 * slow mode switch, and view preferences. Speeds and their limits are left to the screens that
 * show them — repeated down here they only doubled up, or read as a limit with no cause. */
export function StatusBar(): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  // A count, not the downloads: progress ticks don't re-render the footer.
  const waiting = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'queued').length
  )
  const slowMode = useAppStore((store) => store.slowMode)
  const slowModeSpeed = useAppStore((store) => store.slowModeSpeed)
  const setSlowMode = useAppStore((store) => store.setSlowMode)
  const destinationDir = useAppStore((store) => store.destinationDir)
  const [free, setFree] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    const load = (): void => {
      void window.plexo
        .freeSpace(destinationDir)
        .then((bytes) => !disposed && setFree(bytes))
        .catch(() => {})
    }
    load()
    const interval = setInterval(load, FREE_SPACE_POLL_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [destinationDir])

  // Limits show by the speeds they cap (the Downloading screen, the networks menu), not here.
  const status = [
    free !== null && `${formatBytes(free)} free`,
    waiting > 0 && `${waiting} waiting`
  ].filter(Boolean)

  return (
    <ScreenFooter className="gap-4 font-mono text-[11.5px] text-muted-foreground">
      <span className="min-w-0 flex-1 truncate tabular-nums">{status.join(' · ')}</span>
      {/* Controls, most-flipped first: the edge holds the set-once view preferences. */}
      <div className="flex shrink-0 items-center gap-3">
        <UpdateIndicator />
        <Tooltip>
          <TooltipTrigger
            render={
              <label className="flex items-center gap-2">
                Slow mode
                <Switch checked={slowMode} onCheckedChange={setSlowMode} />
              </label>
            }
          />
          <TooltipContent>Limit downloads to {formatSpeed(slowModeSpeed)}</TooltipContent>
        </Tooltip>
        <SpeedUnitToggle />
        <ThemeToggle />
      </div>
    </ScreenFooter>
  )
}
