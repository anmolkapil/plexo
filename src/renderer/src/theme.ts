import type { NetworkInterfaceKind, NetworkPreference, NetworkPreferences } from '@shared/types'

interface KindPalette {
  solid: string
  bg: string
  border: string
  text: string
  /** Glyph/text color for content drawn directly on top of `solid` (e.g. a checkmark). */
  onSolid: string
  label: string
}

function makeKindPalette(name: string, label: string): KindPalette {
  return {
    solid: `var(--color-${name})`,
    bg: `var(--color-${name}-bg)`,
    border: `var(--color-${name}-border)`,
    text: `var(--color-${name}-text)`,
    onSolid: `var(--color-${name}-onsolid)`,
    label
  }
}

// Teal / amber / steel per network, per the "Plexo v2" design — exact hex values live as
// CSS custom properties (main.css) so dark mode reproduces the design precisely while light
// mode gets a coherent, hand-tuned counterpart in the same hues.
export const KIND_PALETTE: Record<NetworkInterfaceKind, KindPalette> = {
  wifi: makeKindPalette('wifi', 'WIFI'),
  usb: makeKindPalette('usb', 'USB'),
  ethernet: makeKindPalette('ethernet', 'ETH'),
  bridge: makeKindPalette('neutral', 'NET'),
  other: makeKindPalette('neutral', 'NET')
}

// The brand amber doubles as the USB network color, exactly as in the design.
export const DANGER = 'var(--color-danger)'

// The table's 20px side gutters live inside the first and last tracks (30px = 20 + the status
// dot's 10, 160px = 140 + 20) rather than as padding on the grid itself. A subgrid row can only
// paint inside its parent's content box, so with the padding on the grid every row divider and
// every expanded row's fill stopped 20px short of the window and had to be faked by an
// absolutely-positioned bleed layer behind each row. With the gutters as tracks, a row box
// already spans window edge to window edge and a plain border/background does the job.
//
// Network sizes to its content (name + streams pill + "⋯" button) instead of a guessed fixed
// px — `max-content` grows it to fit whatever's actually in that cell (no dead trailing space
// before Progress) and, just as importantly, lets it shrink on a narrow window instead of
// holding a fixed width the row can't fit in. Progress is the one column that should visually
// scale with the window (the bar already fills 100% of its track), so it alone takes the
// leftover space; that also keeps the gap after the bar, into Share, the same fixed 12px as
// every other column boundary — instead of Network's gap growing while Progress's stays put.
// The 190px floor exists because every row shares this one subgrid track, collapsed and expanded
// alike: with a floor of 0, expanding a group mounts "Stream #N · Chunk #N · <status>" rows into
// the same column, which is routinely wider than the collapsed row's "<name> · N streams" — so
// the track (and everything right of it) would jump wider the instant you expand. 190px already
// covers that expanded content, so expanding never grows the track further.
export const NETWORK_ROW_GRID_COLUMNS = '30px minmax(190px, max-content) 1fr 48px 78px 160px'

// A curated set of user-selectable network colors, distinct from (and in addition to) the
// kind defaults above — each ships its own on-solid text color so it's legible without having
// to compute contrast for an arbitrary user-picked hue at runtime.
export const NETWORK_COLOR_SWATCHES = [
  { id: 'teal', label: 'Teal', solid: '#4ea89a', onSolid: '#10201d' },
  { id: 'amber', label: 'Amber', solid: '#d8a44c', onSolid: '#221806' },
  { id: 'steel', label: 'Steel', solid: '#7e93bd', onSolid: '#141a26' },
  { id: 'rose', label: 'Rose', solid: '#c97b7b', onSolid: '#210f0f' },
  { id: 'violet', label: 'Violet', solid: '#9c8fd6', onSolid: '#17131f' },
  { id: 'lime', label: 'Lime', solid: '#a3c66a', onSolid: '#161f0d' },
  { id: 'cyan', label: 'Cyan', solid: '#6db8c9', onSolid: '#0d1a1e' },
  { id: 'coral', label: 'Coral', solid: '#d99168', onSolid: '#241209' }
] as const

export type NetworkColorId = (typeof NETWORK_COLOR_SWATCHES)[number]['id']

/** Whether a persisted colorId still names one of the current swatches — a stale id (from a
 * removed swatch, or corrupted storage) must fall back to the kind default rather than be
 * trusted as-is. */
export function isValidNetworkColorId(id: string | undefined): id is NetworkColorId {
  return NETWORK_COLOR_SWATCHES.some((swatch) => swatch.id === id)
}

/** Derives a full surface set (bg/border/text) from a swatch's one solid color, tinted against
 * the ambient theme — same trick as the kind palette, just computed at runtime since these
 * colors are picked by the user rather than baked into the design. */
function tint(source: string, amount: number, base = 'var(--bg-secondary)'): string {
  return `color-mix(in oklch, ${source} ${amount}%, ${base})`
}

export interface NetworkVisual extends KindPalette {
  /** The network's effective display name — the user's custom name if set, else the OS one. */
  name: string
  colorId: NetworkColorId
}

// The swatch each kind's palette is tuned from (same hex in dark mode). Bridge/other have no
// hue of their own — neutral grey reads as "offline" in charts — so they always take a free one.
const KIND_SWATCH: Record<NetworkInterfaceKind, NetworkColorId | undefined> = {
  wifi: 'teal',
  usb: 'amber',
  ethernet: 'steel',
  bridge: undefined,
  other: undefined
}

/** Gives every network exactly one color, distinct from the others while swatches last: a
 * user-picked color always wins, then each network gets its kind's hue if still free, then the
 * first unused swatch — so two USB phones never both render amber. */
export function assignNetworkColors(
  networks: Map<string, NetworkInterfaceKind>,
  preferences: NetworkPreferences
): Map<string, NetworkColorId> {
  // ponytail: ordered by id, so plugging in a same-kind network can shift an unpinned one's color.
  const ids = [...networks.keys()].sort()
  const colors = new Map<string, NetworkColorId>()
  const used = new Set<NetworkColorId>()
  const take = (id: string, color: NetworkColorId): void => {
    colors.set(id, color)
    used.add(color)
  }

  for (const id of ids) {
    const pinned = preferences[id]?.colorId
    if (isValidNetworkColorId(pinned)) take(id, pinned)
  }
  for (const id of ids) {
    const kindColor = KIND_SWATCH[networks.get(id)!]
    if (!colors.has(id) && kindColor && !used.has(kindColor)) take(id, kindColor)
  }
  for (const id of ids) {
    if (colors.has(id)) continue
    const free = NETWORK_COLOR_SWATCHES.find((swatch) => !used.has(swatch.id))?.id
    take(id, free ?? KIND_SWATCH[networks.get(id)!] ?? NETWORK_COLOR_SWATCHES[0].id)
  }
  return colors
}

/** What a network looks like given its assigned color (see assignNetworkColors): the kind's
 * hand-tuned light/dark palette when the color is the kind's own hue, a tint of the swatch
 * otherwise. Name is the user's custom one, else the OS one (e.g. "feth0" -> "iPhone Hotspot"). */
export function resolveNetworkVisual(
  kind: NetworkInterfaceKind,
  fallbackName: string,
  preference: NetworkPreference | undefined,
  colorId: NetworkColorId
): NetworkVisual {
  const name = preference?.customName?.trim() || fallbackName
  const kindPalette = KIND_PALETTE[kind]
  const swatch = NETWORK_COLOR_SWATCHES.find((entry) => entry.id === colorId)!

  if (colorId === KIND_SWATCH[kind]) {
    return { ...kindPalette, name, colorId }
  }

  return {
    colorId,
    solid: swatch.solid,
    bg: tint(swatch.solid, 16),
    border: tint(swatch.solid, 42, 'var(--border-strong)'),
    text: tint(swatch.solid, 62, 'var(--text)'),
    onSolid: swatch.onSolid,
    label: kindPalette.label,
    name
  }
}
