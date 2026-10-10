import type { DownloadSchedule } from '@shared/types'
import { useRef, useState } from 'react'
import { CalendarDays, Clock3 } from 'lucide-react'
import { DEFAULT_DOWNLOAD_SCHEDULE, localDate, validSchedule } from '@shared/downloadSchedule'
import { Button } from './ui/button'
import { Calendar } from './ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './ui/input-group'
import { Switch } from './ui/switch'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (value: number): string => String(value).padStart(2, '0')

function TimeSegment({
  label,
  value,
  max,
  invalid,
  inputRef,
  previous,
  next,
  onChange,
  onPasteTime
}: {
  label: string
  value: number
  max: number
  invalid: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  previous?: React.RefObject<HTMLInputElement | null>
  next?: React.RefObject<HTMLInputElement | null>
  onChange: (value: number) => void
  onPasteTime: (time: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState<string>()
  return (
    <InputGroupInput
      ref={inputRef}
      type="text"
      inputMode="numeric"
      role="spinbutton"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-invalid={invalid}
      autoComplete="off"
      value={draft ?? pad(value)}
      className="w-9 flex-none px-1 text-center font-mono tabular-nums"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => setDraft(undefined)}
      onChange={(event) => {
        const text = event.target.value
        if (!/^\d{0,2}$/.test(text) || Number(text) > max) return
        setDraft(text)
        if (text) onChange(Number(text))
        if (text.length === 2) next?.current?.focus()
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text').trim()
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return
        event.preventDefault()
        onPasteTime(text)
        setDraft(undefined)
        event.currentTarget.blur()
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        const key = event.key
        if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) {
          event.preventDefault()
          const updated =
            key === 'Home'
              ? 0
              : key === 'End'
                ? max
                : (value + (key === 'ArrowUp' ? 1 : max)) % (max + 1)
          onChange(updated)
          setDraft(undefined)
          requestAnimationFrame(() => {
            if (document.activeElement === inputRef.current) inputRef.current?.select()
          })
        } else if ((key === 'ArrowRight' || key === ':') && next?.current) {
          event.preventDefault()
          next.current.focus()
        } else if (key === 'ArrowLeft' && previous?.current) {
          event.preventDefault()
          previous.current.focus()
        }
      }}
    />
  )
}

function TimePicker({
  label,
  value,
  invalid,
  onChange
}: {
  label: string
  value: number
  invalid: boolean
  onChange: (minute: number) => void
}): React.JSX.Element {
  const hourRef = useRef<HTMLInputElement>(null)
  const minuteRef = useRef<HTMLInputElement>(null)
  const hour = Math.floor(value / 60)
  const minute = value % 60
  const pasteTime = (time: string): void => {
    const [hours, minutes] = time.split(':').map(Number)
    onChange(hours * 60 + minutes)
  }
  return (
    <InputGroup aria-label={label} className="gap-0.5 pl-1.5">
      <TimeSegment
        label={`${label} hour`}
        value={hour}
        max={23}
        invalid={invalid}
        inputRef={hourRef}
        next={minuteRef}
        onChange={(next) => onChange(next * 60 + minute)}
        onPasteTime={pasteTime}
      />
      <InputGroupText aria-hidden="true">:</InputGroupText>
      <TimeSegment
        label={`${label} minute`}
        value={minute}
        max={59}
        invalid={invalid}
        inputRef={minuteRef}
        previous={hourRef}
        onChange={(next) => onChange(hour * 60 + next)}
        onPasteTime={pasteTime}
      />
      <InputGroupAddon align="inline-end" className="ml-auto" aria-hidden="true">
        <InputGroupText>24h</InputGroupText>
        <Clock3 />
      </InputGroupAddon>
    </InputGroup>
  )
}

function EndDatePicker({
  value,
  onChange
}: {
  value?: string
  onChange: (date?: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = value ? new Date(`${value}T12:00:00`) : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="End date"
            className="w-full justify-between"
          >
            {selected
              ? selected.toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric'
                })
              : 'No end date'}
            <CalendarDays data-icon="inline-end" />
          </Button>
        }
      />
      <PopoverContent align="start" aria-label="Choose end date" className="w-auto gap-0 p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          weekStartsOn={1}
          autoFocus
          onSelect={(date) => {
            onChange(date ? localDate(date) : undefined)
            setOpen(false)
          }}
        />
        <div className="flex justify-end border-t border-border p-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onChange(undefined)
              setOpen(false)
            }}
          >
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Part of the limits dialog's draft; saving and cancellation belong to its shared footer. */
export function ScheduleFields({
  schedule,
  onChange
}: {
  schedule: DownloadSchedule
  onChange: (schedule: DownloadSchedule) => void
}): React.JSX.Element {
  const change = (patch: Partial<DownloadSchedule>): void => onChange({ ...schedule, ...patch })
  return (
    <section
      className="flex flex-col gap-2.5 border-t-[0.5px] border-border py-3"
      aria-label="Download schedule"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-sans text-[14px] leading-none font-semibold">Download schedule</h4>
        <label className="flex items-center gap-2 text-[13px]">
          Enabled
          <Switch
            aria-label="Enable download schedule"
            checked={schedule.enabled}
            onCheckedChange={(enabled) =>
              onChange({
                ...(validSchedule(schedule) ? schedule : DEFAULT_DOWNLOAD_SCHEDULE),
                enabled
              })
            }
          />
        </label>
      </div>
      {schedule.enabled && (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="sr-only">Schedule times and days</legend>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2 text-[13px]">
              Start at
              <TimePicker
                label="Start at"
                value={schedule.startMinute}
                invalid={schedule.startMinute === schedule.endMinute}
                onChange={(startMinute) => change({ startMinute })}
              />
            </div>
            <div className="flex flex-col gap-2 text-[13px]">
              <span className="flex items-center justify-between gap-2">
                Stop at
                {schedule.endMinute < schedule.startMinute && (
                  <span className="text-[12px] text-muted-foreground">Next day</span>
                )}
              </span>
              <TimePicker
                label="Stop at"
                value={schedule.endMinute}
                invalid={schedule.startMinute === schedule.endMinute}
                onChange={(endMinute) => change({ endMinute })}
              />
            </div>
          </div>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-[13px]">Repeat on</legend>
            <ToggleGroup
              multiple
              value={schedule.days.map(String)}
              onValueChange={(values) => change({ days: values.map(Number) })}
              variant="pill"
              size="xs"
              spacing={1}
              aria-label="Schedule days"
              className="flex-wrap"
            >
              {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                <ToggleGroupItem
                  key={day}
                  value={String(day)}
                  aria-label={DAYS[day]}
                  className="h-6 min-w-6 px-2"
                >
                  {DAYS[day]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </fieldset>
          <div className="flex flex-col gap-2 text-[13px]">
            <span className="flex items-center justify-between gap-2">
              End date
              <span className="text-[12px] text-muted-foreground">Optional</span>
            </span>
            <EndDatePicker value={schedule.endDate} onChange={(endDate) => change({ endDate })} />
          </div>
        </fieldset>
      )}
    </section>
  )
}
