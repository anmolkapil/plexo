import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { useFormatSpeed, useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import { formatDataUsage } from '../utils/format'
import { NetworkEditPopover } from './NetworkEditPopover'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { TruncatedText } from './TruncatedText'

/** Every network the computer has, one row each: on the left what it is (its name, the system's
 * name for it, the limits set on it), on the right what it's doing (its speed). Which
 * networks a download uses is picked in New download, which remembers the last pick. */
export function NetworksMenu({
  onOpenLimits
}: {
  /** Opens Speed & data limits on that network's page, or General for null. */
  onOpenLimits: (page: string | null) => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const formatSpeedLimit = useFormatSpeedLimit()
  const interfaces = useAppStore((store) => store.interfaces)
  const preferences = useAppStore((store) => store.networkPreferences)
  const downloads = useAppStore((store) => store.downloads)
  const networkVisual = useNetworkVisuals()
  const [open, setOpen] = useState(false)
  const usage = useNetworkUsage(open)

  // Every running download's speed over each network, added up.
  const speeds = new Map<string, number>()
  for (const download of Object.values(downloads)) {
    if (download.status !== 'downloading') continue
    for (const network of download.networks) {
      speeds.set(network.id, (speeds.get(network.id) ?? 0) + network.speedBytesPerSec)
    }
  }
  const total = [...speeds.values()].reduce((sum, speed) => sum + speed, 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="secondary" className="gap-2.5 px-3 text-[13px]" />}
      >
        <span className="flex gap-1" aria-hidden>
          {interfaces.slice(0, 4).map((iface) => (
            <span
              key={iface.id}
              className="size-2 rounded-full"
              style={{ background: networkVisual(iface.id, iface.kind, iface.displayName).solid }}
            />
          ))}
        </span>
        {interfaces.length === 0 ? (
          <span className="text-[var(--color-danger)]">No network</span>
        ) : (
          <>
            {interfaces.length} {interfaces.length === 1 ? 'network' : 'networks'}
            {total > 0 && (
              <span className="font-mono text-[11.5px] text-muted-foreground">
                {formatSpeed(total)}
              </span>
            )}
          </>
        )}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px] gap-0 p-0">
        <div className="border-b-[0.5px] border-border px-4 py-3 text-[14px] font-semibold">
          Networks
        </div>
        {interfaces.map((iface) => {
          const visual = networkVisual(iface.id, iface.kind, iface.displayName)
          const preference = preferences[iface.id]
          const used = usage[iface.id] ?? 0
          const speedLimit = preference?.speedLimit
          const dataLimit = preference?.dataLimit
          const reached = dataLimit !== undefined && used >= dataLimit
          const speed = speeds.get(iface.id) ?? 0
          const lineClass =
            'col-start-2 col-span-2 truncate font-mono text-[11px] text-muted-foreground'
          return (
            <div
              key={iface.id}
              // The whole row opens this network's limits (the chevron's button stretches over it);
              // the pencil and the badge sit above it and do their own thing.
              className="group relative grid grid-cols-[8px_minmax(0,1fr)_auto_16px] items-center gap-x-3 gap-y-1 border-b-[0.5px] border-border px-4 py-3 hover:bg-muted"
            >
              <span className="size-2 rounded-full" style={{ background: visual.solid }} />
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium">{visual.name}</span>
                <span className="relative z-10 flex">
                  <NetworkEditPopover
                    interfaceId={iface.id}
                    interfaceKind={iface.kind}
                    osName={iface.displayName}
                  />
                </span>
                {/* The system's own name for the adapter, beside the user's. A long one (a Windows
                    driver name) is cut off, and only then is there a tooltip with all of it. */}
                <span className="relative z-10 flex max-w-[110px] min-w-0 shrink-0 rounded-[4px] border-[0.5px] border-border bg-foreground/5 px-1.5 font-mono text-[10.5px] text-muted-foreground">
                  <TruncatedText text={iface.displayName} />
                </span>
              </div>
              {/* What it's doing: a used-up network is paused, which says why it carries nothing. */}
              <div
                className="text-right font-mono text-[12px] font-medium whitespace-nowrap text-muted-foreground"
                style={
                  reached
                    ? { color: 'var(--color-danger)' }
                    : speed > 0
                      ? { color: visual.text }
                      : undefined
                }
              >
                {reached ? 'Paused' : speed > 0 ? formatSpeed(speed) : 'Idle'}
              </div>
              <button
                type="button"
                aria-label={`${visual.name} limits`}
                className="text-muted-foreground outline-none group-hover:text-foreground after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                onClick={() => {
                  setOpen(false)
                  onOpenLimits(iface.id)
                }}
              >
                <ChevronRight className="size-4" />
              </button>
              {/* A line per limit set on it, as short as it can be said; none, and the row is one
                  line. "Limit", not "Max": a max reads as what the network can do. */}
              {speedLimit !== undefined && (
                <div className={lineClass}>Limit {formatSpeedLimit(speedLimit)}</div>
              )}
              {/* The figure, then a bar for how much is left at a glance. The period and when it
                  resets are a click away, in the limits the row opens. */}
              {dataLimit !== undefined && (
                <div
                  className="col-span-2 col-start-2 flex items-center gap-3 font-mono text-[11px] text-muted-foreground"
                  style={reached ? { color: 'var(--color-danger)' } : undefined}
                >
                  <span className="shrink-0">{formatDataUsage(used, dataLimit)}</span>
                  <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (used / dataLimit) * 100)}%`,
                        background: reached ? 'var(--color-danger)' : visual.solid
                      }}
                    />
                  </span>
                </div>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className="px-4 py-3 text-[13px] font-medium text-primary hover:underline"
          onClick={() => {
            setOpen(false)
            onOpenLimits(null)
          }}
        >
          Speed &amp; data limits
        </button>
      </PopoverContent>
    </Popover>
  )
}
