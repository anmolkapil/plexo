import { Settings } from 'lucide-react'
import { useState } from 'react'
import { usableHostCount, useSocks5Store } from '../store/useSocks5Store'
import { Socks5Dialog } from './Socks5Dialog'
import { Button } from './ui/button'
import { Switch } from './ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** The SOCKS5 switch for the status bar, and the way into the servers it spreads connections over. */
export function Socks5Control(): React.JSX.Element {
  const settings = useSocks5Store((store) => store.settings)
  const setEnabled = useSocks5Store((store) => store.setEnabled)
  const [open, setOpen] = useState(false)
  const hosts = usableHostCount(settings)

  const toggle = (enabled: boolean): void => {
    // Nothing to connect through yet: the dialog is where one is added.
    if (enabled && hosts === 0) return setOpen(true)
    void setEnabled(enabled).catch(() => {})
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <label className="flex items-center gap-2">
              SOCKS5
              <Switch checked={settings.enabled} onCheckedChange={toggle} />
            </label>
          }
        />
        <TooltipContent>
          {settings.enabled
            ? `Downloads use ${hosts} SOCKS5 server${hosts === 1 ? '' : 's'}`
            : 'Send downloads through your SOCKS5 servers'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="SOCKS5 servers"
              onClick={() => setOpen(true)}
              className="-ml-1.5 text-muted-foreground"
            >
              <Settings />
            </Button>
          }
        />
        <TooltipContent>SOCKS5 servers</TooltipContent>
      </Tooltip>
      <Socks5Dialog open={open} onOpenChange={setOpen} />
    </>
  )
}
