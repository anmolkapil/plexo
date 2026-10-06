import { SPEED_HISTORY_SECONDS } from '@shared/types'
import { useState } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'
import { useAppStore } from '../store/useAppStore'
import { speedTicks } from '../utils/format'

const WIDTH = 560
const HEIGHT = 130
const labelClass = 'font-mono text-[9px] leading-none text-muted-foreground tabular-nums'

interface ThroughputChartProps {
  order: Array<{ interfaceId: string; solid: string; name: string }>
  historyByInterface: Record<string, number[]>
  /** Where the minute ends: now, or — the history only grows while it downloads — where it
   * paused, or where it finished. So a paused download's last speed never reads as "now". */
  endsAt?: 'now' | 'pause' | 'end'
}

/** Stacked area chart of recent throughput, split by physical network — the "whole divided
 * by each physical network" readout from design v2, instead of one line per connection. A scale
 * to read it by, a time axis, and on hover every network's speed at that second. */
export function ThroughputChart({
  order,
  historyByInterface,
  endsAt = 'now'
}: ThroughputChartProps): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const speedUnit = useAppStore((store) => store.speedUnit)
  // The second under the pointer, as a slot of the minute (0 = a minute ago, last = now).
  const [hovered, setHovered] = useState<number | null>(null)
  const length = Math.max(
    0,
    ...order.map((entry) => historyByInterface[entry.interfaceId]?.length ?? 0)
  )

  const totals = Array.from({ length }, (_, i) =>
    order.reduce((sum, entry) => sum + (historyByInterface[entry.interfaceId]?.[i] ?? 0), 0)
  )
  // Round steps to read values off, the top just clearing the fastest second: it moves less than
  // a scale topped by the data itself, and every gridline means a number.
  const { top, ticks } = speedTicks(Math.max(0, ...totals), speedUnit)
  // Fewer than two samples draws no area at all — but the empty gridlines still render, so the
  // chart keeps its height. It's the tallest thing in the hero band, and bailing out to `null`
  // for the first second of a download (or after a resume re-keys the history) collapsed the
  // band and shoved the whole screen up, then back down again.
  // A fixed minute, newest at the right edge, as Activity Monitor and Task Manager draw it: a
  // second is always the same width, so the shape only scrolls, and the first few seconds sit at
  // the right with the rest still empty instead of being stretched across the whole chart.
  const xStep = WIDTH / (SPEED_HISTORY_SECONDS - 1)
  const firstSlot = SPEED_HISTORY_SECONDS - length
  const firstX = firstSlot * xStep
  const toY = (value: number): number => HEIGHT - (value / top) * HEIGHT

  interface Layer {
    solid: string
    points: string
  }
  const toPoint = (value: number, i: number): string =>
    `${(firstX + i * xStep).toFixed(1)},${toY(value).toFixed(1)}`
  const { layers } = order.reduce<{ cumulative: number[]; layers: Layer[] }>(
    (acc, entry) => {
      const series = historyByInterface[entry.interfaceId] ?? []
      const bottom = acc.cumulative
      const top = bottom.map((value, i) => value + (series[i] ?? 0))
      const points = [...top.map(toPoint), ...bottom.map(toPoint).reverse()].join(' ')
      return { cumulative: top, layers: [...acc.layers, { solid: entry.solid, points }] }
    },
    { cumulative: new Array<number>(length).fill(0), layers: [] }
  )

  const outline = totals.map(toPoint).join(' ')

  const peakTotal = Math.max(0, ...totals)
  const latestTotal = totals[totals.length - 1] ?? 0

  // Only a second that has a sample shows a readout: before the download's first, there's none.
  const sample = hovered === null ? -1 : hovered - firstSlot
  const readout = sample >= 0 && sample < length ? sample : null
  const slotPercent = (slot: number): string => `${(slot / (SPEED_HISTORY_SECONDS - 1)) * 100}%`
  const secondsAgo = SPEED_HISTORY_SECONDS - 1 - (hovered ?? 0)

  return (
    // Clear of the heading above: the top label centres on the top gridline, so it rises above it.
    <div className="mt-4 flex gap-2">
      {/* The scale, beside the plot rather than over the fills, where it would be hard to read.
          Each number with its unit, so any one reads on its own. */}
      <div className="shrink-0 text-right">
        <div className="relative h-[104px]">
          {/* The widest label, invisible, gives the column its width. */}
          <span className={`invisible block ${labelClass}`}>{ticks.at(-1)?.label}</span>
          {ticks.map((tick) => (
            <span
              key={tick.value}
              className={`absolute right-0 -translate-y-1/2 ${labelClass}`}
              style={{ top: `${(1 - tick.value / top) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="relative h-[104px]"
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
            setHovered(Math.round(fraction * (SPEED_HISTORY_SECONDS - 1)))
          }}
          onPointerLeave={() => setHovered(null)}
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            className="block h-full w-full"
            role="img"
            aria-label={`Combined throughput over the last minute. Currently ${formatSpeed(latestTotal)}, fastest ${formatSpeed(peakTotal)}.`}
          >
            {/* Muted ink at low opacity: quiet but seen in either theme, where --border all but
                vanished against the dark band. */}
            <g
              className="text-muted-foreground"
              stroke="currentColor"
              strokeOpacity={0.3}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            >
              {ticks.map((tick) => (
                <line
                  key={tick.value}
                  x1={0}
                  y1={toY(tick.value)}
                  x2={WIDTH}
                  y2={toY(tick.value)}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
            {layers.map((layer, index) => (
              <polygon key={index} points={layer.points} fill={layer.solid} fillOpacity={0.62} />
            ))}
            <polyline
              points={outline}
              fill="none"
              stroke="var(--node-accent)"
              strokeWidth={2}
              strokeOpacity={0.85}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {readout !== null && hovered !== null && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
                style={{ left: slotPercent(hovered) }}
              />
              {/* Every network at that second, so the pointer needn't land on a fill; on the side
                  away from the edge it would run off. */}
              <div
                className="pointer-events-none absolute top-0 z-10 flex min-w-[150px] flex-col gap-1 rounded-md border-[0.5px] border-border bg-popover px-2.5 py-2 font-mono text-[11px] tabular-nums shadow-md"
                style={
                  hovered > (SPEED_HISTORY_SECONDS - 1) / 2
                    ? { right: `calc(100% - ${slotPercent(hovered)} + 8px)` }
                    : { left: `calc(${slotPercent(hovered)} + 8px)` }
                }
              >
                <span className="text-[10px] text-muted-foreground">
                  {secondsAgo === 0
                    ? `${endsAt[0].toUpperCase()}${endsAt.slice(1)}`
                    : `${secondsAgo}s ${endsAt === 'now' ? 'ago' : `before the ${endsAt}`}`}
                </span>
                {order.map((entry) => (
                  <span key={entry.interfaceId} className="flex items-center gap-2">
                    <span className="size-2 rounded-full" style={{ background: entry.solid }} />
                    <span className="flex-1 truncate font-sans text-[11.5px]">{entry.name}</span>
                    {formatSpeed(historyByInterface[entry.interfaceId]?.[readout] ?? 0)}
                  </span>
                ))}
                {order.length > 1 && (
                  <span className="flex items-center gap-2 border-t-[0.5px] border-border pt-1">
                    <span className="flex-1 font-sans text-[11.5px]">Total</span>
                    {formatSpeed(totals[readout])}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div className={`mt-1 flex justify-between ${labelClass}`}>
          <span>
            {SPEED_HISTORY_SECONDS}s {endsAt === 'now' ? 'ago' : `before the ${endsAt}`}
          </span>
          <span>{endsAt}</span>
        </div>
      </div>
    </div>
  )
}
