import type { NetworkInterfaceKind, ProxyConfig, ProxyType } from '@shared/types'
import { cn } from 'cn'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { NETWORK_COLOR_SWATCHES, type NetworkColorId } from '../theme'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface NetworkEditPopoverProps {
  interfaceId: string
  interfaceKind: NetworkInterfaceKind
  osName: string
}

const fieldLabelClass =
  'font-mono text-[9px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase'

const MAX_NETWORK_NAME_LENGTH = 40

const PROXY_TYPES: { id: ProxyType; label: string }[] = [
  { id: 'http', label: 'HTTP' },
  { id: 'https', label: 'HTTPS' },
  { id: 'socks5', label: 'SOCKS5' },
  { id: 'socks4', label: 'SOCKS4' }
]

/** Rename/recolor one network and configure per-interface proxy settings. Edits are a draft
 * that's saved when the popover closes — Done, Enter or clicking away — and thrown away on Escape. */
export function NetworkEditPopover({
  interfaceId,
  interfaceKind,
  osName
}: NetworkEditPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const preference = useAppStore((store) => store.networkPreferences[interfaceId])
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const visual = useNetworkVisuals()(interfaceId, interfaceKind, osName)

  const [draftName, setDraftName] = useState('')
  const [draftColorId, setDraftColorId] = useState<NetworkColorId>(visual.colorId)

  // Proxy draft state
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyType, setProxyType] = useState<ProxyType>('http')
  const [proxyHost, setProxyHost] = useState('')
  const [proxyPort, setProxyPort] = useState('')
  const [proxyUsername, setProxyUsername] = useState('')
  const [proxyPassword, setProxyPassword] = useState('')

  function save(): void {
    const trimmed = draftName.trim().slice(0, MAX_NETWORK_NAME_LENGTH)
    const customName = trimmed && trimmed !== osName ? trimmed : undefined
    // Re-picking the color it already had keeps it automatic instead of pinning it.
    const colorId = draftColorId === visual.colorId ? preference?.colorId : draftColorId

    const hostTrimmed = proxyHost.trim()
    const parsedPort = parseInt(proxyPort.trim(), 10)
    const defaultPort = proxyType.startsWith('socks') ? 1080 : 8080
    const port =
      !isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : defaultPort

    const hasProxyConfig = proxyEnabled || hostTrimmed.length > 0 || preference?.proxy != null
    const proxy: ProxyConfig | undefined = hasProxyConfig
      ? {
          enabled: proxyEnabled,
          type: proxyType,
          host: hostTrimmed,
          port,
          username: proxyUsername.trim() || undefined,
          password: proxyPassword || undefined
        }
      : undefined

    const proxyChanged = JSON.stringify(preference?.proxy ?? null) !== JSON.stringify(proxy ?? null)
    if (customName !== preference?.customName || colorId !== preference?.colorId || proxyChanged) {
      setNetworkPreference(interfaceId, { customName, colorId, proxy })
    }
  }

  function close(): void {
    save()
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          setDraftName(visual.name)
          setDraftColorId(visual.colorId)
          const p = preference?.proxy
          setProxyEnabled(Boolean(p?.enabled))
          setProxyType(p?.type ?? 'http')
          setProxyHost(p?.host ?? '')
          setProxyPort(p?.port ? String(p.port) : '')
          setProxyUsername(p?.username ?? '')
          setProxyPassword(p?.password ?? '')
        } else if (details.reason !== 'escape-key') {
          save()
        }
        setOpen(next)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Edit network"
                  className="shrink-0 text-muted-foreground"
                >
                  <Pencil className="size-3" />
                </Button>
              }
            />
          }
        />
        <TooltipContent>Edit network</TooltipContent>
      </Tooltip>
      <PopoverContent aria-label={`Edit ${visual.name}`} className="w-[320px] gap-3 p-3">
        <div className="flex flex-col gap-[6px]">
          <label htmlFor={`network-name-${interfaceId}`} className={fieldLabelClass}>
            Name
          </label>
          <input
            id={`network-name-${interfaceId}`}
            type="text"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onFocus={(event) => event.target.select()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') close()
            }}
            placeholder={osName}
            maxLength={MAX_NETWORK_NAME_LENGTH}
            autoFocus
            className="rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-sans text-[12px] leading-[1.3] font-medium text-foreground outline-none focus-visible:border-ring"
          />
        </div>

        <div className="flex flex-col gap-[6px]">
          <span className={fieldLabelClass}>Color</span>
          <div className="flex items-center justify-between px-1 py-1">
            {NETWORK_COLOR_SWATCHES.map((swatch) => {
              const isSelected = draftColorId === swatch.id
              return (
                <Tooltip key={swatch.id}>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => setDraftColorId(swatch.id)}
                        aria-label={swatch.label}
                        aria-pressed={isSelected}
                        className="size-6 shrink-0 rounded-full border-none p-[2px]"
                      >
                        <span
                          className="block size-full rounded-full"
                          style={{
                            background: swatch.solid,
                            boxShadow: isSelected
                              ? `0 0 0 2px var(--color-popover), 0 0 0 4px ${swatch.solid}`
                              : undefined
                          }}
                        />
                      </button>
                    }
                  />
                  <TooltipContent>{swatch.label}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        </div>

        <div className="h-px bg-border/60" />

        {/* Proxy configuration section */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className={fieldLabelClass}>Proxy</span>
            <label className="group flex cursor-pointer items-center gap-1.5 select-none">
              <Checkbox
                checked={proxyEnabled}
                onCheckedChange={(checked) => setProxyEnabled(Boolean(checked))}
              />
              <span className="font-sans text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
                Enable proxy
              </span>
            </label>
          </div>

          {proxyEnabled && (
            <div className="flex flex-col gap-2.5 pt-0.5">
              {/* Proxy Type Segmented Control */}
              <div className="flex flex-col gap-1">
                <span className={fieldLabelClass}>Protocol</span>
                <div className="grid grid-cols-4 gap-1 rounded-md bg-muted/50 p-0.5">
                  {PROXY_TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setProxyType(t.id)}
                      className={cn(
                        'rounded-[4px] py-1 text-center font-mono text-[10px] font-semibold transition-all',
                        proxyType === t.id
                          ? 'bg-background text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Host and Port */}
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`proxy-host-${interfaceId}`} className={fieldLabelClass}>
                    Host / IP
                  </label>
                  <input
                    id={`proxy-host-${interfaceId}`}
                    type="text"
                    value={proxyHost}
                    onChange={(event) => setProxyHost(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') close()
                    }}
                    placeholder="127.0.0.1"
                    className="rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-mono text-[11px] leading-[1.3] text-foreground outline-none focus-visible:border-ring placeholder:text-muted-foreground/50"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`proxy-port-${interfaceId}`} className={fieldLabelClass}>
                    Port
                  </label>
                  <input
                    id={`proxy-port-${interfaceId}`}
                    type="text"
                    inputMode="numeric"
                    value={proxyPort}
                    onChange={(event) => setProxyPort(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') close()
                    }}
                    placeholder={proxyType.startsWith('socks') ? '1080' : '8080'}
                    className="rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-mono text-[11px] leading-[1.3] text-foreground outline-none focus-visible:border-ring placeholder:text-muted-foreground/50"
                  />
                </div>
              </div>

              {/* Authentication */}
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label htmlFor={`proxy-user-${interfaceId}`} className={fieldLabelClass}>
                    User <span className="text-[8px] font-normal lowercase opacity-70">(opt)</span>
                  </label>
                  <input
                    id={`proxy-user-${interfaceId}`}
                    type="text"
                    value={proxyUsername}
                    onChange={(event) => setProxyUsername(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') close()
                    }}
                    placeholder="username"
                    autoComplete="off"
                    className="rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-sans text-[11px] leading-[1.3] text-foreground outline-none focus-visible:border-ring placeholder:text-muted-foreground/50"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={`proxy-pass-${interfaceId}`} className={fieldLabelClass}>
                    Password{' '}
                    <span className="text-[8px] font-normal lowercase opacity-70">(opt)</span>
                  </label>
                  <input
                    id={`proxy-pass-${interfaceId}`}
                    type="password"
                    value={proxyPassword}
                    onChange={(event) => setProxyPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') close()
                    }}
                    placeholder={proxyType === 'socks4' ? 'N/A' : '••••••••'}
                    autoComplete="off"
                    disabled={proxyType === 'socks4'}
                    className={cn(
                      'rounded-[6px] border border-input bg-background px-[9px] py-1.5 font-sans text-[11px] leading-[1.3] text-foreground outline-none focus-visible:border-ring placeholder:text-muted-foreground/50',
                      proxyType === 'socks4' && 'cursor-not-allowed bg-muted/40 opacity-50'
                    )}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button type="button" size="xs" onClick={close}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
