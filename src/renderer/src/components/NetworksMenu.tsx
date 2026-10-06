import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useLatencyPolling, useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { formatSpeedOfLimit } from '../utils/format'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { UsageBar } from './LimitsDialog'
import { NetworkEditPopover } from './NetworkEditPopover'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

/** The networks new downloads combine, switched on or off here; each download can still change
 * its own. Also how fast each is going right now, and how much of its data limit is left. */
export function NetworksMenu({
  onOpenLimits
}: {
  /** Opens Speed & data limits on that network's page, or General for null. */
  onOpenLimits: (page: string | null) => void
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const speedUnit = useAppStore((store) => store.speedUnit)
  /** "8.0 / 10.0 MB/s" against a network's own limit, so it shows without opening the limits. */
  const speedText = (speed: number, limit: number | undefined): string => {
    if (limit === undefined) return speed > 0 ? formatSpeed(speed) : 'Idle'
    const [value, max] = formatSpeedOfLimit(speed, limit, speedUnit)
    return speed > 0 ? `${value} / ${max}` : `Idle · limit ${max}`
  }
  const interfaces = useAppStore((store) => store.interfaces)
  const preferences = useAppStore((store) => store.networkPreferences)
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const downloads = useAppStore((store) => store.downloads)
  const networkVisual = useNetworkVisuals()
  const latencies = useAppStore((store) => store.latencies)
  const [open, setOpen] = useState(false)
  const usage = useNetworkUsage(open)
  useLatencyPolling(open)

  // Every running download's speed over each network, added up.
  const speeds = new Map<string, number>()
  for (const download of Object.values(downloads)) {
    if (download.status !== 'downloading') continue
    for (const network of download.networks) {
      speeds.set(network.id, (speeds.get(network.id) ?? 0) + network.speedBytesPerSec)
    }
  }
  const total = [...speeds.values()].reduce((sum, speed) => sum + speed, 0)
  const on = interfaces.filter((iface) => !preferences[iface.id]?.off)

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
              style={{
                background: networkVisual(iface.id, iface.kind, iface.displayName).solid,
                opacity: preferences[iface.id]?.off ? 0.3 : 1
              }}
            />
          ))}
        </span>
        {interfaces.length === 0 ? (
          <span className="text-[var(--color-danger)]">No network</span>
        ) : (
          <>
            {on.length} {on.length === 1 ? 'network' : 'networks'}
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
        <div className="flex flex-col gap-1.5 border-b-[0.5px] border-border p-4">
          <div className="text-[14px] font-semibold">Default networks</div>
          <div className="text-[12.5px] leading-snug text-[var(--text-secondary)]">
            New downloads combine the networks turned on here. You can change this for any single
            download.
          </div>
        </div>
        {interfaces.map((iface) => {
          const visual = networkVisual(iface.id, iface.kind, iface.displayName)
          const preference = preferences[iface.id]
          const used = usage[iface.id] ?? 0
          const dataLimit = preference?.dataLimit
          const reached = dataLimit !== undefined && used >= dataLimit
          const speed = speeds.get(iface.id) ?? 0
          return (
            <div
              key={iface.id}
              // The whole row opens this network's limits (the chevron's button stretches over it);
              // the switch and the pencil sit above it and do their own thing.
              className="group relative flex flex-col gap-2 border-b-[0.5px] border-border px-4 py-3 hover:bg-muted"
            >
              <div className="flex items-center gap-3">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: visual.solid }}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-[13.5px] font-medium">{visual.name}</span>
                    <span className="relative z-10 flex">
                      <NetworkEditPopover
                        interfaceId={iface.id}
                        interfaceKind={iface.kind}
                        osName={iface.displayName}
                      />
                    </span>
                  </div>
                  <div
                    className={`font-mono text-[11px] ${reached ? 'text-[var(--color-danger)]' : 'text-muted-foreground'}`}
                  >
                    {reached
                      ? 'Data limit reached'
                      : [
                          iface.displayName,
                          speedText(speed, preference?.speedLimit),
                          typeof latencies[iface.id] === 'number' &&
                            `${Math.round(latencies[iface.id]!)} ms`
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                  </div>
                </div>
                <Switch
                  className="relative z-10"
                  aria-label={`Use ${visual.name} for new downloads`}
                  checked={!preference?.off}
                  onCheckedChange={(checked) =>
                    setNetworkPreference(iface.id, { off: checked ? undefined : true })
                  }
                />
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
              </div>
              {dataLimit !== undefined && (
                <UsageBar
                  used={used}
                  limit={dataLimit}
                  period={preference?.dataLimitPeriod ?? 'month'}
                />
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
          Speed &amp; data limits…
        </button>
      </PopoverContent>
    </Popover>
  )
}
