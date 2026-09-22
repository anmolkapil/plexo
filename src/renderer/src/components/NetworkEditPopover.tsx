import type { NetworkInterfaceKind } from '@shared/types'
import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { NETWORK_COLOR_SWATCHES, type NetworkColorId } from '../theme'
import { Button } from './ui/button'
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

/** Rename/recolor one network. Edits are a draft that's saved when the popover closes — Done,
 * Enter or clicking away — and thrown away on Escape, like renaming a file in Finder. */
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

  function save(): void {
    const trimmed = draftName.trim().slice(0, MAX_NETWORK_NAME_LENGTH)
    const customName = trimmed && trimmed !== osName ? trimmed : undefined
    // Re-picking the color it already had keeps it automatic instead of pinning it.
    const colorId = draftColorId === visual.colorId ? preference?.colorId : draftColorId
    if (customName !== preference?.customName || colorId !== preference?.colorId) {
      void setNetworkPreference(interfaceId, { customName, colorId })
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
      <PopoverContent aria-label={`Edit ${visual.name}`} className="gap-3 p-3">
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
                      // The 24px button is the WCAG 2.5.8 hit target; the visible 20px dot lives
                      // in the padding-shrunk inner span so the swatch itself doesn't grow.
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
                            // Popover-colored gap, then a ring in the swatch's own hue — reads in both themes.
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

        <div className="flex justify-end">
          <Button type="button" size="xs" onClick={close}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
