import type { UpdateState } from '@shared/types'
import { cn } from 'cn'
import { CircleAlert, CircleArrowUp, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

function describe({ status, version, percent, autoUpdate }: UpdateState): string {
  switch (status) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Plexo ${version} is available`
    case 'downloading':
      return `Downloading Plexo ${version}… ${percent}%`
    case 'ready':
      return `Plexo ${version} is ready — restart to update`
    case 'error':
      return `Couldn’t install Plexo ${version}`
    default:
      return autoUpdate ? 'Plexo updates automatically' : 'Automatic updates are off'
  }
}

/** Where the app's own update is, at a glance. Clicking opens the update menu (see
 * main/updater.ts) — natively, so it's the same menu as the macOS app menu's. Nothing in a
 * Microsoft Store install, which the Store updates. */
export function UpdateIndicator(): React.JSX.Element | null {
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', autoUpdate: true })

  useEffect(() => {
    const stop = window.plexo.onUpdateState(setUpdate)
    window.plexo.updateState().then(setUpdate, () => {})
    return stop
  }, [])

  const { status, percent } = update
  if (status === 'store') return null
  const label = describe(update)
  const text =
    status === 'downloading'
      ? `${percent}%`
      : status === 'ready'
        ? 'Restart to update'
        : status === 'available'
          ? 'Update'
          : null
  const busy = status === 'checking' || status === 'downloading'
  const Icon = busy ? LoaderCircle : status === 'error' ? CircleAlert : CircleArrowUp

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => void window.plexo.showUpdateMenu()}
            className={cn(
              'flex h-[26px] min-w-[26px] shrink-0 cursor-default items-center justify-center gap-1.5 rounded-[6px] border-[0.5px] border-border bg-secondary px-[5px] [-webkit-app-region:no-drag]',
              status === 'available' || status === 'ready'
                ? 'text-primary'
                : 'text-[var(--text-secondary)]'
            )}
          >
            <Icon size={15} strokeWidth={1.3} className={busy ? 'animate-spin' : undefined} />
            {text && <span className="tabular-nums">{text}</span>}
          </button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
