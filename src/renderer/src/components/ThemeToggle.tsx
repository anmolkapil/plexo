import type { ThemeSource } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const OPTIONS: { id: ThemeSource; nextLabel: string; icon: React.JSX.Element }[] = [
  {
    id: 'light',
    nextLabel: 'Switch to dark theme',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.4 3.6l-1.13 1.13M4.73 11.27L3.6 12.4M12.4 12.4l-1.13-1.13M4.73 4.73L3.6 3.6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  },
  {
    id: 'dark',
    nextLabel: 'Switch to light theme',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M13.5 9.85A5.6 5.6 0 0 1 6.15 2.5a5.6 5.6 0 1 0 7.35 7.35Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
]

export function ThemeToggle(): React.JSX.Element {
  const themeSource = useAppStore((store) => store.themeSource)
  const setThemeSource = useAppStore((store) => store.setThemeSource)

  const current = OPTIONS.find((option) => option.id === themeSource) ?? OPTIONS[0]

  const toggle = (): void => {
    void setThemeSource(current.id === 'light' ? 'dark' : 'light')
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={current.nextLabel}
            onClick={toggle}
            className="flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-[0.5px] border-border bg-secondary text-[var(--text-secondary)] [-webkit-app-region:no-drag]"
          >
            {current.icon}
          </button>
        }
      />
      <TooltipContent>{current.nextLabel}</TooltipContent>
    </Tooltip>
  )
}
