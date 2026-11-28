import { DOWNLOAD_PAGE } from '@shared/links'
import type { UpdateState } from '@shared/types'
import { CircleAlert, CircleArrowUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
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
      return `Plexo ${version} is ready`
    case 'error':
      return `Couldn’t install Plexo ${version}`
    default:
      return autoUpdate ? 'Plexo updates automatically' : 'Automatic updates are off'
  }
}

function useUpdateState(): UpdateState {
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', autoUpdate: true })
  useEffect(() => {
    const stop = window.plexo.onUpdateState(setUpdate)
    window.plexo.updateState().then(setUpdate, () => {})
    return stop
  }, [])
  return update
}

const CHIP =
  'flex h-[26px] min-w-[26px] shrink-0 cursor-default items-center gap-1.5 rounded-[6px] border-[0.5px] border-border bg-secondary px-[5px] [-webkit-app-region:no-drag]'

/** Like Claude desktop, but it also shows the download and a failed install: nothing while there's
 * no update, then progress, then one click to restart. A failed install sends you to the website. */
export function UpdateIndicator(): React.JSX.Element | null {
  const update = useUpdateState()
  const { status, percent } = update
  let chip: React.JSX.Element
  if (status === 'downloading') {
    chip = (
      <span
        role="progressbar"
        aria-valuenow={percent ?? 0}
        aria-valuetext={describe(update)}
        className={`${CHIP} text-primary`}
      >
        {/* pathLength 100 lets the dash be the percent; -rotate-90 starts it at 12 o'clock. */}
        <svg viewBox="0 0 16 16" className="size-[15px] -rotate-90" aria-hidden>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="var(--border)" strokeWidth="1.5" />
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${percent ?? 0} 100`}
          />
        </svg>
        Downloading update
      </span>
    )
  } else if (status === 'ready') {
    chip = (
      <button
        type="button"
        onClick={() => void window.plexo.restartToUpdate()}
        className={`${CHIP} text-primary`}
      >
        <CircleArrowUp size={15} strokeWidth={1.3} />
        Restart to update
      </button>
    )
  } else if (status === 'error') {
    chip = (
      <a
        href={DOWNLOAD_PAGE}
        target="_blank"
        rel="noreferrer"
        className={`${CHIP} text-[var(--text-secondary)]`}
      >
        <CircleAlert size={15} strokeWidth={1.3} />
        Update failed
      </a>
    )
  } else {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>
        {status === 'downloading'
          ? `Plexo ${update.version} · ${percent}%`
          : status === 'error'
            ? `${describe(update)}. Get it from the website.`
            : describe(update)}
      </TooltipContent>
    </Tooltip>
  )
}

export function UpdatesPage(): React.JSX.Element {
  const update = useUpdateState()
  return (
    <div className="grid gap-3">
      <h2 className="font-semibold">Updates</h2>
      <label className="flex items-center justify-between gap-3 font-medium">
        Update automatically
        <Switch
          checked={update.autoUpdate}
          onCheckedChange={(on) => void window.plexo.setAutoUpdate(on)}
        />
      </label>
      <p className="text-sm text-muted-foreground">{describe(update)}</p>
      {update.status === 'available' && (
        <Button className="justify-self-start" onClick={() => void window.plexo.downloadUpdate()}>
          Download Plexo {update.version}
        </Button>
      )}
      <Button
        variant="outline"
        className="justify-self-start"
        disabled={
          update.status !== 'idle' && update.status !== 'available' && update.status !== 'error'
        }
        onClick={() => void window.plexo.checkForUpdates()}
      >
        Check for updates
      </Button>
    </div>
  )
}
