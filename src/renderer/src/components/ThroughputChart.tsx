import { formatSpeed } from '../utils/format'

const WIDTH = 560
const HEIGHT = 130

interface ThroughputChartProps {
  order: Array<{ interfaceId: string; solid: string }>
  historyByInterface: Record<string, number[]>
}

/** Stacked area chart of recent throughput, split by physical network — the "whole divided
 * by each physical network" readout from design v2, instead of one line per connection. */
export function ThroughputChart({
  order,
  historyByInterface
}: ThroughputChartProps): React.JSX.Element {
  const length = Math.max(
    0,
    ...order.map((entry) => historyByInterface[entry.interfaceId]?.length ?? 0)
  )

  const totals = Array.from({ length }, (_, i) =>
    order.reduce((sum, entry) => sum + (historyByInterface[entry.interfaceId]?.[i] ?? 0), 0)
  )
  const max = Math.max(1, ...totals)
  // Fewer than two samples draws no area at all — but the empty gridlines still render, so the
  // chart keeps its height. It's the tallest thing in the hero band, and bailing out to `null`
  // for the first second of a download (or after a resume re-keys the history) collapsed the
  // band and shoved the whole screen up, then back down again.
  const xStep = length > 1 ? WIDTH / (length - 1) : WIDTH
  const toY = (value: number): number => HEIGHT - (value / max) * HEIGHT

  interface Layer {
    solid: string
    points: string
  }
  const toPoint = (value: number, i: number): string =>
    `${(i * xStep).toFixed(1)},${toY(value).toFixed(1)}`
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

  const outline = totals
    .map((value, i) => `${(i * xStep).toFixed(1)},${toY(value).toFixed(1)}`)
    .join(' ')

  const peakTotal = Math.max(0, ...totals)
  const latestTotal = totals[totals.length - 1] ?? 0

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="mt-[7px] block h-[104px] w-full"
      role="img"
      aria-label={`Combined throughput over time. Currently ${formatSpeed(latestTotal)}, peak ${formatSpeed(peakTotal)}.`}
    >
      <g stroke="var(--border)" strokeWidth={1}>
        <line x1={0} y1={HEIGHT * 0.33} x2={WIDTH} y2={HEIGHT * 0.33} />
        <line x1={0} y1={HEIGHT * 0.66} x2={WIDTH} y2={HEIGHT * 0.66} />
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
      />
    </svg>
  )
}
