import { DATA_LIMIT_PERIODS, dataUsageLabel, nextDataReset } from '@shared/dataLimits'
import {
  DEFAULT_SLOW_MODE_SPEED,
  DOWNLOADS_AT_ONCE,
  type DataLimitPeriod,
  type NetworkPreference
} from '@shared/types'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useNetworkUsage } from '../hooks/useNetworks'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { describeError, formatBytes, formatDataUsage } from '../utils/format'
import { useFormatSpeedLimit } from '../hooks/useFormatSpeed'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from './ui/alert-dialog'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

/** What the dialog edits: a copy taken when it opens, written back only on Save. */
type Draft = Pick<
  ReturnType<typeof useAppStore.getState>,
  'speedLimit' | 'slowMode' | 'slowModeSpeed' | 'downloadsAtOnce' | 'networkPreferences'
>

/** All downloads as a fresh install has them. */
const GENERAL_DEFAULTS = {
  speedLimit: undefined,
  slowMode: false,
  slowModeSpeed: DEFAULT_SLOW_MODE_SPEED,
  downloadsAtOnce: DOWNLOADS_AT_ONCE.default
} satisfies Partial<Draft>

const MB = 1024 ** 2
const GB = 1024 ** 3

/** A speed is typed in the unit picked in the footer; anything under one is a decimal. */
const SPEED_UNITS = {
  bytes: { label: 'MB/s', bytes: MB },
  bits: { label: 'Mbps', bytes: 1000 ** 2 / 8 }
}

const sectionClass = 'flex flex-col gap-2.5 border-t-[0.5px] border-border py-3'
const headingClass = 'font-sans text-[14px] leading-none font-semibold'
const hintClass = 'text-[12.5px] leading-snug text-[var(--text-secondary)]'
const navLabelClass =
  'px-2.5 pt-3 pb-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-foreground uppercase'

/** A number of `unit`s typed in, as bytes; anything that isn't a positive number is ignored. */
function NumberInput({
  bytes,
  unit,
  unitBytes,
  label,
  disabled = false,
  onChange
}: {
  bytes: number
  unit: string
  unitBytes: number
  label: string
  disabled?: boolean
  onChange: (bytes: number) => void
}): React.JSX.Element {
  // Keep the draft as typed; changing units remounts it using the same byte value. Rounded, as
  // bytes saved in one unit rarely come out whole in another (20 MB/s is 167.77216 Mbps) — but
  // under one by significant digits, not decimals: 1 KB/s is 0.000977 MB/s, and two decimals read
  // that as a 0 MB/s limit that still applies.
  const [text, setText] = useState(() => {
    const value = bytes / unitBytes
    return String(Number(value >= 1 ? value.toFixed(2) : value.toPrecision(3)))
  })
  return (
    <span className="flex items-center gap-2">
      <Input
        aria-label={label}
        inputMode="decimal"
        disabled={disabled}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          const value = Number(event.target.value)
          const converted = Math.round(value * unitBytes)
          if (Number.isSafeInteger(converted) && converted > 0) onChange(converted)
        }}
        className="w-20 text-right font-mono tabular-nums"
      />
      <span className="font-mono text-[12px] text-muted-foreground">{unit}</span>
    </span>
  )
}

function SpeedInput({
  bytes,
  label,
  disabled = false,
  onChange
}: {
  bytes: number
  label: string
  disabled?: boolean
  onChange: (bytes: number) => void
}): React.JSX.Element {
  const unit = SPEED_UNITS[useAppStore((store) => store.speedUnit)]
  return (
    <NumberInput
      key={unit.label}
      bytes={bytes}
      unit={unit.label}
      unitBytes={unit.bytes}
      label={`${label}, in ${unit.label}`}
      disabled={disabled}
      onChange={onChange}
    />
  )
}

/** No limit, or an editable limit: a speed when no unit is given. Turning it off retains the
 * last value while open. */
function LimitChoice({
  label,
  value,
  fallback,
  unit,
  unitBytes,
  onChange,
  children
}: {
  children?: React.ReactNode
  label: string
  value: number | undefined
  fallback: number
  unit?: string
  unitBytes?: number
  onChange: (bytes: number | undefined) => void
}): React.JSX.Element {
  const name = useId()
  const [lastValue, setLastValue] = useState(value ?? fallback)
  const enabled = value !== undefined
  const changeValue = (bytes: number): void => {
    setLastValue(bytes)
    onChange(bytes)
  }
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-2">
      <label className="flex w-fit items-center gap-2.5 text-[13px]">
        <input
          type="radio"
          name={name}
          checked={!enabled}
          onChange={() => {
            if (value !== undefined) setLastValue(value)
            onChange(undefined)
          }}
          className="size-4 accent-[var(--color-accent)]"
        />
        No limit
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex items-center gap-2.5 text-[13px]">
          <input
            type="radio"
            name={name}
            checked={enabled}
            onChange={() => onChange(lastValue)}
            className="size-4 accent-[var(--color-accent)]"
          />
          Limit to
        </label>
        {unit === undefined || unitBytes === undefined ? (
          <SpeedInput
            key={enabled ? 'on' : 'off'}
            bytes={value ?? lastValue}
            label={label}
            disabled={!enabled}
            onChange={changeValue}
          />
        ) : (
          <NumberInput
            key={enabled ? 'on' : 'off'}
            bytes={value ?? lastValue}
            unit={unit}
            unitBytes={unitBytes}
            label={`${label}, in ${unit}`}
            disabled={!enabled}
            onChange={changeValue}
          />
        )}
        {children}
      </div>
    </div>
  )
}

function GeneralPage({
  running,
  draft,
  change
}: {
  running: number
  draft: Draft
  change: (patch: Partial<Draft>) => void
}): React.JSX.Element {
  const { speedLimit, slowMode, slowModeSpeed, downloadsAtOnce } = draft
  const [confirmReset, setConfirmReset] = useState(false)
  const atDefaults = Object.entries(GENERAL_DEFAULTS).every(
    ([key, value]) => draft[key as keyof typeof GENERAL_DEFAULTS] === value
  )

  return (
    <>
      <div className="flex flex-col gap-1 pb-3">
        <h3 className="font-sans text-[18px] leading-none font-semibold">All downloads</h3>
        <div className="font-mono text-[12px] text-muted-foreground">
          {running === 0 ? 'No active downloads' : `${running} downloading right now`}
        </div>
      </div>

      <section className={sectionClass}>
        <h4 className={headingClass}>Total speed</h4>
        <p className={hintClass}>Limits the combined download speed across all networks.</p>
        <LimitChoice
          label="Total speed"
          value={speedLimit}
          fallback={20 * MB}
          onChange={(speedLimit) => change({ speedLimit })}
        />
      </section>

      <section className={sectionClass}>
        <h4 className={headingClass}>Slow mode</h4>
        <p className={hintClass}>
          Replaces the total speed limit while enabled. Useful during calls or streaming.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SpeedInput
            bytes={slowModeSpeed}
            label="Slow mode speed"
            onChange={(slowModeSpeed) => change({ slowModeSpeed })}
          />
          <label className="ml-auto flex items-center gap-2 text-[13px]">
            Enabled
            <Switch checked={slowMode} onCheckedChange={(slowMode) => change({ slowMode })} />
          </label>
        </div>
      </section>

      <section className={sectionClass}>
        <h4 className={headingClass}>Downloads at once</h4>
        <p className={hintClass}>Other downloads wait in the queue and start automatically.</p>
        <div className="flex items-center gap-3 text-[13.5px]">
          <div className="flex items-center rounded-lg border border-input">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Decrease simultaneous downloads"
              disabled={downloadsAtOnce <= DOWNLOADS_AT_ONCE.min}
              onClick={() => change({ downloadsAtOnce: downloadsAtOnce - 1 })}
            >
              <Minus />
            </Button>
            <output
              aria-label="Downloads at once"
              className="w-8 text-center font-mono tabular-nums"
            >
              {downloadsAtOnce}
            </output>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Increase simultaneous downloads"
              disabled={downloadsAtOnce >= DOWNLOADS_AT_ONCE.max}
              onClick={() => change({ downloadsAtOnce: downloadsAtOnce + 1 })}
            >
              <Plus />
            </Button>
          </div>
          at the same time
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-2 border-t-[0.5px] border-border pt-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={atDefaults}
          onClick={() => setConfirmReset(true)}
        >
          Reset to defaults…
        </Button>
      </div>
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset all downloads to defaults?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets total speed, slow mode and downloads at once. Network limits stay
              unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => change(GENERAL_DEFAULTS)}>
              Reset to defaults
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function NetworkPage({
  id,
  name,
  used,
  onUsageReset,
  preference,
  change
}: {
  id: string
  name: string
  used: number
  onUsageReset: () => void
  preference: NetworkPreference | undefined
  change: (patch: NetworkPreference) => void
}): React.JSX.Element {
  const dataLimit = preference?.dataLimit
  const period = preference?.dataLimitPeriod ?? 'month'
  const [reset, setReset] = useState<'usage' | 'limits' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmReset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (reset === 'usage') {
        await window.plexo.resetNetworkUsage(id)
        onUsageReset()
      } else change({ speedLimit: undefined, dataLimit: undefined })
      setReset(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <div className="flex flex-col gap-1 pb-3">
        <h3 className="font-sans text-[18px] leading-none font-semibold">{name}</h3>
        <div className="font-mono text-[12px] text-muted-foreground">
          {formatBytes(used)} used by Plexo {dataUsageLabel(period)}
        </div>
      </div>

      <section className={sectionClass}>
        <h4 className={headingClass}>Speed</h4>
        <p className={hintClass}>Limits the combined download speed on {name}.</p>
        <LimitChoice
          label={`${name} speed`}
          value={preference?.speedLimit}
          fallback={10 * MB}
          onChange={(speedLimit) => change({ speedLimit })}
        />
      </section>

      <section className={sectionClass}>
        <h4 className={headingClass}>Data limit</h4>
        <p className={hintClass}>
          Stops downloads on {name} at the limit. Uploads and other apps don’t count.
        </p>
        <LimitChoice
          label={`${name} data limit`}
          value={dataLimit}
          fallback={5 * GB}
          unit="GB"
          unitBytes={GB}
          onChange={(limit) => change({ dataLimit: limit })}
        >
          <span className="text-[12px] text-muted-foreground">per</span>
          <ToggleGroup
            aria-label={`${name} data limit period`}
            value={[period]}
            disabled={dataLimit === undefined}
            onValueChange={(values) => {
              const next = values[0]
              if (next === 'day' || next === 'week' || next === 'month') {
                change({ dataLimitPeriod: next })
              }
            }}
            size="sm"
            spacing={0.5}
            className="bg-secondary p-0.5"
          >
            {DATA_LIMIT_PERIODS.map((entry) => (
              <ToggleGroupItem key={entry.value} value={entry.value}>
                {entry.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </LimitChoice>
        {dataLimit !== undefined && (
          <>
            <UsageBar used={used} limit={dataLimit} period={period} />
            <p className="text-[11.5px] text-muted-foreground">
              Resets{' '}
              {period === 'day'
                ? 'tomorrow at midnight'
                : `on ${nextDataReset(period, now).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`}
              . {period === 'week' && 'Weeks start Monday. '}Raise the limit or reset data usage to
              keep using this network sooner.
            </p>
          </>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-2 border-t-[0.5px] border-border pt-3">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || used === 0}
          onClick={() => setReset('usage')}
        >
          Reset data usage…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || (preference?.speedLimit === undefined && dataLimit === undefined)}
          onClick={() => setReset('limits')}
        >
          Remove limits…
        </Button>
      </div>
      <AlertDialog open={reset !== null} onOpenChange={(open) => !open && !busy && setReset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {reset === 'usage' ? `Reset data usage for ${name}?` : `Remove limits for ${name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {reset === 'usage'
                ? `This resets ${name}’s usage ${dataUsageLabel(period)} to zero. Its configured limits and usage for other periods stay unchanged. Downloads can use this network again if its data limit was reached.`
                : `This removes ${name}’s speed and data limits. Its recorded data usage stays unchanged. The total speed limit and slow mode still apply.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                void confirmReset()
              }}
            >
              {reset === 'usage' ? 'Reset data usage' : 'Remove limits'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** "5.00 of 5 GB this month", with a bar that turns red once the limit is reached. */
function UsageBar({
  used,
  limit,
  period = 'month'
}: {
  used: number
  limit: number
  period?: DataLimitPeriod
}): React.JSX.Element {
  const reached = used >= limit
  const color = reached ? 'var(--color-danger)' : 'var(--color-wifi)'
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, (used / limit) * 100)}%`, background: color }}
        />
      </div>
      <div
        className={`font-mono text-[11.5px] whitespace-nowrap ${reached ? 'text-[var(--color-danger)]' : 'text-muted-foreground'}`}
      >
        {formatBytes(used)} of {formatBytes(limit)} {dataUsageLabel(period)}
      </div>
    </div>
  )
}

/** One line under a network's name: its limits, or that it has reached one. */
function describeLimits(
  preference: NetworkPreference | undefined,
  used: number,
  formatSpeedLimit: (bytesPerSec: number) => string
): string[] {
  if (preference?.dataLimit !== undefined && used >= preference.dataLimit) {
    return ['Data limit reached']
  }
  // A line each, said as the networks menu says them, so the two never read differently.
  const lines = [
    preference?.speedLimit !== undefined && `Limit ${formatSpeedLimit(preference.speedLimit)}`,
    preference?.dataLimit !== undefined && formatDataUsage(used, preference.dataLimit)
  ].filter((line): line is string => typeof line === 'string')
  return lines.length > 0 ? lines : ['No limit']
}

/** Speed & data limits: every download's together, and each network's. Nothing changes until
 * Save; Cancel (or Escape) leaves everything as it was. Resetting data usage is the exception:
 * it's an action, not a setting, so it happens once confirmed. */
export function LimitsDialog({
  open,
  onOpenChange,
  page,
  onPageChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The network shown, by interface id; null for General. */
  page: string | null
  onPageChange: (page: string | null) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(520px,calc(100%-2rem))] max-w-[680px] flex-col gap-0 p-0 sm:max-w-[680px]"
      >
        {/* Mounted only while open, so each opening starts a fresh draft. */}
        <LimitsEditor page={page} onPageChange={onPageChange} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function LimitsEditor({
  page,
  onPageChange,
  onClose
}: {
  page: string | null
  onPageChange: (page: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const formatSpeedLimit = useFormatSpeedLimit()
  const interfaces = useAppStore((store) => store.interfaces)
  const [draft, setDraft] = useState<Draft>(() => {
    const { speedLimit, slowMode, slowModeSpeed, downloadsAtOnce, networkPreferences } =
      useAppStore.getState()
    return { speedLimit, slowMode, slowModeSpeed, downloadsAtOnce, networkPreferences }
  })
  const change = (patch: Partial<Draft>): void =>
    setDraft((previous) => ({ ...previous, ...patch }))
  const changeNetwork = (id: string, patch: NetworkPreference): void =>
    setDraft((previous) => ({
      ...previous,
      networkPreferences: {
        ...previous.networkPreferences,
        [id]: { ...previous.networkPreferences[id], ...patch }
      }
    }))
  // Only what changed is written, so a running download isn't re-limited for nothing.
  const save = (): void => {
    const store = useAppStore.getState()
    if (draft.speedLimit !== store.speedLimit) store.setSpeedLimit(draft.speedLimit)
    if (draft.slowMode !== store.slowMode) store.setSlowMode(draft.slowMode)
    if (draft.slowModeSpeed !== store.slowModeSpeed) store.setSlowModeSpeed(draft.slowModeSpeed)
    if (draft.downloadsAtOnce !== store.downloadsAtOnce) {
      store.setDownloadsAtOnce(draft.downloadsAtOnce)
    }
    for (const [id, preference] of Object.entries(draft.networkPreferences)) {
      if (preference !== store.networkPreferences[id]) store.setNetworkPreference(id, preference)
    }
    onClose()
  }
  const { speedLimit, slowMode, networkPreferences: preferences } = draft
  const running = useAppStore(
    (store) =>
      Object.values(store.downloads).filter((download) => download.status === 'downloading').length
  )
  const networkVisual = useNetworkVisuals()
  const [usageRevision, setUsageRevision] = useState(0)
  const usage = useNetworkUsage(true, usageRevision)
  const shown = interfaces.find((iface) => iface.id === page)

  const navItem = (
    key: string | null,
    dot: string,
    name: string,
    detail: string[],
    warn = false
  ): React.JSX.Element => (
    <button
      key={key ?? 'general'}
      type="button"
      aria-current={page === key ? 'page' : undefined}
      onClick={() => onPageChange(key)}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-primary/10"
    >
      <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[13.5px] font-medium">{name}</span>
        {/* A line per fact, each cut off rather than wrapped: the sidebar is narrow. */}
        {detail.map((line) => (
          <span
            key={line}
            className={`truncate font-mono text-[11px] ${warn ? 'text-[var(--color-danger)]' : 'text-muted-foreground'}`}
          >
            {line}
          </span>
        ))}
      </span>
    </button>
  )

  return (
    <>
      <div className="flex items-center border-b-[0.5px] border-border px-4 py-3">
        <DialogTitle className="text-[16px] font-semibold">Speed &amp; data limits</DialogTitle>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r-[0.5px] border-border p-2">
          <div className={navLabelClass}>General</div>
          {navItem(null, 'var(--text-secondary)', 'All downloads', [
            slowMode
              ? 'Slow mode on'
              : speedLimit
                ? `Limit ${formatSpeedLimit(speedLimit)}`
                : 'No limit'
          ])}
          <div className={navLabelClass}>Networks</div>
          {interfaces.map((iface) => {
            const visual = networkVisual(iface.id, iface.kind, iface.displayName)
            const detail = describeLimits(
              preferences[iface.id],
              usage[iface.id] ?? 0,
              formatSpeedLimit
            )
            return navItem(
              iface.id,
              visual.solid,
              visual.name,
              detail,
              detail[0] === 'Data limit reached'
            )
          })}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {shown ? (
            <NetworkPage
              key={shown.id}
              id={shown.id}
              name={networkVisual(shown.id, shown.kind, shown.displayName).name}
              used={usage[shown.id] ?? 0}
              onUsageReset={() => setUsageRevision((value) => value + 1)}
              preference={preferences[shown.id]}
              change={(patch) => changeNetwork(shown.id, patch)}
            />
          ) : (
            <GeneralPage running={running} draft={draft} change={change} />
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-border px-4 py-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={save}>
          Save
        </Button>
      </div>
    </>
  )
}
