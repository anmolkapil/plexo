import { useLayoutEffect, useState } from 'react'
import { useFormatSpeed } from '../hooks/useFormatSpeed'

const ROW_HEIGHT = 36
// Gaps between the label column and the rest of the diagram stay fixed — only the label
// column's own width flexes with the longest network name, so a long custom label (the dev
// tool lets you type anything) grows the diagram instead of getting cut off.
const DOT_GAP = 8
const CURVE_GAP = 6
const CURVE_LEN = 64
const STREAM_LEN = 42
// The most `fill` lengthens the curves and the stream by, between them: past it they're only
// flatter, not clearer.
const MAX_FILL_EXTRA = 400
const END_PAD = 8
const MIN_LABEL_X = 68
const MAX_LABEL_CHARS = 18
// Rough advance width (px) of one uppercase glyph in the label's 8.5px mono font plus its
// 0.08em letter-spacing — an overestimate is safer here than an underestimate, since this
// sizes an SVG column rather than flowing text a browser could wrap or ellipsize for us.
const CHAR_WIDTH = 6.4
const LABEL_EDGE_PAD = 4

export interface CombineDiagramNetwork {
  solid: string
  label: string
  speedBytesPerSec?: number
}

/** Draws the multiple-links-into-one-stream diagram: individual networks with their
 * real-time speed on the left, converging into a single combined stream pointing
 * directly to the final total speed on the right. */
export function CombineDiagram({
  networks,
  muted = false,
  paused = false,
  fill = false
}: {
  networks: CombineDiagramNetwork[]
  muted?: boolean
  paused?: boolean
  /** Takes the room it's given (flex-1) and lengthens the merge to use it, the arrow kept against
   * whatever follows; otherwise it's drawn at its natural size. */
  fill?: boolean
}): React.JSX.Element {
  const formatSpeed = useFormatSpeed()
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [room, setRoom] = useState(0)
  // Measured before paint, so the first frame isn't drawn short and then stretched.
  useLayoutEffect(() => {
    if (!node) return
    const measure = (): void => setRoom(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])
  const height = Math.max(78, networks.length * ROW_HEIGHT + 10)
  const midY = height / 2

  const longestLabelChars = Math.min(
    MAX_LABEL_CHARS,
    networks.reduce((max, network) => Math.max(max, network.label.trim().length), 0)
  )
  const LABEL_X = Math.max(MIN_LABEL_X, longestLabelChars * CHAR_WIDTH + LABEL_EDGE_PAD)
  const DOT_X = LABEL_X + DOT_GAP
  const CURVE_START_X = DOT_X + CURVE_GAP
  const naturalWidth = CURVE_START_X + CURVE_LEN + STREAM_LEN + END_PAD
  const extra = fill ? Math.min(MAX_FILL_EXTRA, Math.max(0, room - naturalWidth)) : 0
  const COMBINE_X = CURVE_START_X + CURVE_LEN + extra / 2
  const STREAM_END_X = COMBINE_X + STREAM_LEN + extra / 2
  const WIDTH = STREAM_END_X + END_PAD

  const diagram = (
    <svg
      viewBox={`0 0 ${WIDTH} ${height}`}
      className="block shrink-0"
      style={{ width: WIDTH, height }}
    >
      <g fill="none" strokeWidth={3} strokeLinecap="round">
        {networks.map((network, index) => {
          const y = (index + 0.5) * (height / networks.length)
          const color = muted ? 'var(--icon-muted)' : network.solid
          return (
            <path
              key={network.label + index}
              d={`M${CURVE_START_X},${y.toFixed(1)} C${CURVE_START_X + 36},${y.toFixed(1)} ${COMBINE_X - 26},${midY.toFixed(1)} ${COMBINE_X},${midY.toFixed(1)}`}
              stroke={color}
              strokeDasharray="6 8"
              opacity={paused ? 0.55 : 1}
              style={
                muted || paused
                  ? undefined
                  : { animation: `plexo-dash ${1.1 + index * 0.2}s linear infinite` }
              }
            />
          )
        })}
        <path
          d={`M${COMBINE_X},${midY} L${STREAM_END_X},${midY}`}
          stroke={
            muted ? 'var(--icon-muted)' : paused ? 'var(--text-secondary)' : 'var(--node-accent)'
          }
          strokeWidth={6.5}
          opacity={paused ? 0.6 : 1}
        />
      </g>
      <polygon
        points={`${STREAM_END_X - 1},${midY - 4.5} ${STREAM_END_X + 6},${midY} ${STREAM_END_X - 1},${midY + 4.5}`}
        fill={muted ? 'var(--icon-muted)' : paused ? 'var(--text-secondary)' : 'var(--node-accent)'}
        opacity={paused ? 0.6 : 1}
      />
      <circle
        cx={COMBINE_X}
        cy={midY}
        r={9.5}
        fill="none"
        stroke={muted ? 'var(--icon-muted)' : 'var(--node-accent)'}
        strokeOpacity={muted ? 1 : 0.25}
        strokeWidth={1.5}
        strokeDasharray={muted ? '3 4' : undefined}
      />
      <circle
        cx={COMBINE_X}
        cy={midY}
        r={3.5}
        fill={muted ? 'var(--icon-muted)' : 'var(--node-accent)'}
      />
      {networks.map((network, index) => {
        const y = (index + 0.5) * (height / networks.length)
        const color = muted ? 'var(--icon-muted)' : network.solid
        return <circle key={`dot-${index}`} cx={DOT_X} cy={y} r={3.5} fill={color} />
      })}
      {networks.map((network, index) => {
        const y = (index + 0.5) * (height / networks.length)
        const label =
          network.label.trim().length > MAX_LABEL_CHARS
            ? `${network.label
                .trim()
                .slice(0, MAX_LABEL_CHARS - 1)
                .toUpperCase()}…`
            : network.label.trim().toUpperCase()
        const hasSpeed = network.speedBytesPerSec != null && network.speedBytesPerSec > 0
        const speedText = hasSpeed ? formatSpeed(network.speedBytesPerSec!) : '—'

        return (
          <g key={`info-${index}`}>
            <text
              x={LABEL_X}
              y={y - 5.5}
              textAnchor="end"
              fill={muted ? 'var(--icon-muted)' : 'var(--text-tertiary)'}
              className="font-mono text-[8.5px] font-medium tracking-[0.08em]"
            >
              <title>{network.label}</title>
              {label}
            </text>
            {!muted && (
              <text
                x={LABEL_X}
                y={y + 7.5}
                textAnchor="end"
                fill={hasSpeed ? network.solid : 'var(--text-tertiary)'}
                className="font-mono text-[11px] font-semibold tabular-nums"
              >
                {speedText}
              </text>
            )}
          </g>
        )
      })}
      {!muted && !paused && (
        <text
          x={STREAM_END_X + 2}
          y={midY - 11}
          textAnchor="end"
          fill="var(--text-tertiary)"
          className="font-mono text-[8.5px] tracking-[0.12em] font-medium"
        >
          COMBINED
        </text>
      )}
    </svg>
  )
  return fill ? (
    // Right-aligned, so the arrow stays pointed into what follows however wide the room is.
    <div ref={setNode} className="flex flex-1 justify-end" style={{ minWidth: naturalWidth }}>
      {diagram}
    </div>
  ) : (
    diagram
  )
}
