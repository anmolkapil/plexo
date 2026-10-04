import { Menu } from '@base-ui/react/menu'
import { Check, ChevronDown } from 'lucide-react'
import type { DownloadFilter } from '../store/useAppStore'

const DOWNLOAD_FILTERS: { value: DownloadFilter; label: string }[] = [
  { value: 'all', label: 'All downloads' },
  { value: 'progress', label: 'In progress' },
  { value: 'finished', label: 'Finished' },
  { value: 'failed', label: 'Needs attention' }
]

export function DownloadFilterMenu({
  value,
  counts,
  onChange
}: {
  value: DownloadFilter
  counts: Record<DownloadFilter, number>
  onChange: (value: DownloadFilter) => void
}): React.JSX.Element {
  const label = DOWNLOAD_FILTERS.find((filter) => filter.value === value)!.label
  return (
    <Menu.Root>
      <h1>
        <Menu.Trigger className="flex h-8 items-center gap-2 rounded-lg px-2.5 font-sans text-[14px] leading-none font-semibold outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">
          {label}
          <ChevronDown aria-hidden className="size-3.5 text-muted-foreground" />
        </Menu.Trigger>
      </h1>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={8} className="isolate z-50">
          <Menu.Popup className="w-52 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none">
            <Menu.RadioGroup
              value={value}
              onValueChange={onChange}
              aria-label="Filter downloads"
              className="flex flex-col gap-0.5"
            >
              {DOWNLOAD_FILTERS.map((filter) => (
                <Menu.RadioItem
                  key={filter.value}
                  value={filter.value}
                  label={filter.label}
                  closeOnClick
                  className="flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none data-checked:bg-muted data-highlighted:bg-muted"
                >
                  <span className="size-4 shrink-0">
                    <Menu.RadioItemIndicator>
                      <Check aria-hidden className="size-4 text-primary" />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span className="flex-1">{filter.label}</span>
                  <span className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {counts[filter.value]}
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
