import type { NetworkInterfaceKind, SimulatedNetworkConfig } from '@shared/types'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError, toDisplayPath } from '../utils/format'
import { TruncatedText } from './TruncatedText'
import { Button } from './ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from './ui/dialog'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const KIND_OPTIONS: NetworkInterfaceKind[] = ['wifi', 'usb', 'ethernet', 'bridge', 'other']
const PRESET_CONNECTIONS = [1, 2, 4, 8] as const
const MAX_SIM_NETWORKS = 4
const MBPS_TO_BYTES_PER_SEC = (1024 * 1024) / 8
const MB_TO_BYTES_PER_SEC = 1024 * 1024
const DEFAULT_ASSEMBLE_SPEED_MBPS = 6

interface SimNetworkDraft {
  key: number
  kind: NetworkInterfaceKind
  label: string
  speedMbps: number
  faultRatePercent: number
}

let nextKey = 0
function makeDraft(kind: NetworkInterfaceKind, label: string, speedMbps: number): SimNetworkDraft {
  return { key: nextKey++, kind, label, speedMbps, faultRatePercent: 0 }
}

const DEFAULT_NETWORKS: SimNetworkDraft[] = [
  makeDraft('wifi', 'Simulated Wi-Fi', 30),
  makeDraft('usb', 'Simulated USB', 12)
]

const fieldLabelClass =
  'font-mono text-[9.5px] leading-none font-medium tracking-[0.12em] text-muted-foreground'

const rowInputClass =
  'rounded-[6px] border-[0.5px] border-[var(--border-strong)] bg-[var(--input-bg)] px-[7px] py-[5px] font-mono text-[12px] leading-[1.3] text-foreground'

const draftBoxClass =
  'flex flex-col gap-1.5 rounded-lg border-[0.5px] border-border bg-background p-2'

/**
 * Dev-only panel that exercises the whole download pipeline against a file already on disk —
 * chunking across fake networks, the block grid, retries/errors, pause/resume, assembling,
 * completion — without needing a real multi-network setup or a slow, flaky server to provoke
 * the states that are otherwise hard to reproduce on demand. Only rendered when
 * `useAppStore.isDev` is true (see App.tsx), so it never reaches a packaged build's UI.
 */
export function DevToolsPanel(): React.JSX.Element | null {
  const isDev = useAppStore((store) => store.isDev)
  const downloadsDir = useAppStore((store) => store.downloadsDir)
  const homeDir = useAppStore((store) => store.homeDir)

  const [open, setOpen] = useState(false)
  const [sourceFilePath, setSourceFilePath] = useState<string | null>(null)
  const [destinationDir, setDestinationDir] = useState('')
  const [networks, setNetworks] = useState<SimNetworkDraft[]>(DEFAULT_NETWORKS)
  const [connectionsPerNetwork, setConnectionsPerNetwork] = useState(2)
  const [slowAssemble, setSlowAssemble] = useState(true)
  const [assembleSpeedMBps, setAssembleSpeedMBps] = useState(DEFAULT_ASSEMBLE_SPEED_MBPS)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Menu item lives in the main process (see installDevMenu in src/main/index.ts) — it can't
  // reach this component's state directly, so it round-trips through IPC instead.
  useEffect(() => {
    if (!isDev) return
    return window.plexo.onToggleDevToolsPanel(() => setOpen((v) => !v))
  }, [isDev])

  if (!isDev) return null

  const effectiveDestinationDir = destinationDir || downloadsDir

  const handleChooseFile = async (): Promise<void> => {
    const chosen = await window.plexo.chooseSourceFile()
    if (chosen) setSourceFilePath(chosen)
  }

  const handleChooseDestination = async (): Promise<void> => {
    const chosen = await window.plexo.chooseDestinationFolder(effectiveDestinationDir)
    if (chosen) setDestinationDir(chosen)
  }

  const updateNetwork = (key: number, patch: Partial<SimNetworkDraft>): void => {
    setNetworks((prev) => prev.map((n) => (n.key === key ? { ...n, ...patch } : n)))
  }

  const addNetwork = (): void => {
    if (networks.length >= MAX_SIM_NETWORKS) return
    setNetworks((prev) => [
      ...prev,
      makeDraft('ethernet', `Simulated Network ${prev.length + 1}`, 20)
    ])
  }

  const removeNetwork = (key: number): void => {
    setNetworks((prev) => (prev.length > 1 ? prev.filter((n) => n.key !== key) : prev))
  }

  const canStart = Boolean(sourceFilePath) && Boolean(effectiveDestinationDir) && !starting

  const handleStart = async (): Promise<void> => {
    if (!sourceFilePath || !effectiveDestinationDir) return
    setStarting(true)
    setError(null)
    try {
      const simulatedNetworks: SimulatedNetworkConfig[] = networks.map((n) => ({
        kind: n.kind,
        label: n.label.trim() || 'Simulated Network',
        speedBytesPerSec: Math.max(1, Math.round(n.speedMbps * MBPS_TO_BYTES_PER_SEC)),
        faultRatePercent: Math.min(100, Math.max(0, n.faultRatePercent))
      }))
      await window.plexo.startSimulatedDownload({
        sourceFilePath,
        destinationDir: effectiveDestinationDir,
        networks: simulatedNetworks,
        chunkCount: networks.length * connectionsPerNetwork,
        connectionsPerNetwork,
        assembleSpeedBytesPerSec: slowAssemble
          ? Math.max(1, Math.round(assembleSpeedMBps * MB_TO_BYTES_PER_SEC))
          : undefined
      })
      setOpen(false)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // showCloseButton={false}: this panel keeps its own close button inline in the header
        // row below, not the default absolute-positioned one.
        showCloseButton={false}
        className="flex max-h-[calc(100%-4rem)] w-[380px] max-w-[380px] flex-col gap-3 overflow-y-auto rounded-[12px] border-[0.5px] border-[var(--border-strong)] bg-card p-4 [overscroll-behavior:contain] sm:max-w-[380px]"
      >
        <div className="flex items-center justify-between">
          <DialogTitle className="font-sans text-[13px] leading-[1.2] font-bold text-foreground">
            Simulate a download
          </DialogTitle>
          <DialogClose
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Close"
                className="font-sans text-sm leading-none font-semibold text-muted-foreground"
              >
                ×
              </Button>
            }
          />
        </div>
        <div className="font-sans text-[11.5px] leading-[1.4] text-muted-foreground">
          Pick a file already on disk to “download” it through the real pipeline — chunking, the
          block grid, pause/resume, retries, assembling — against fake networks you control.
        </div>

        <div className="flex flex-col gap-[5px]">
          <div className={fieldLabelClass}>SOURCE FILE</div>
          <div className="flex gap-1.5">
            <div
              className={`${rowInputClass} min-w-0 flex-1 ${
                sourceFilePath ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              <TruncatedText
                text={sourceFilePath ? toDisplayPath(sourceFilePath, homeDir) : 'No file chosen'}
                tooltipText={sourceFilePath ?? 'No file chosen'}
              />
            </div>
            <Button type="button" variant="secondary" onClick={handleChooseFile}>
              Choose…
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-[5px]">
          <div className={fieldLabelClass}>DESTINATION</div>
          <div className="flex gap-1.5">
            <div className={`${rowInputClass} min-w-0 flex-1`}>
              <TruncatedText
                text={toDisplayPath(effectiveDestinationDir, homeDir)}
                tooltipText={effectiveDestinationDir}
              />
            </div>
            <Button type="button" variant="secondary" onClick={handleChooseDestination}>
              Browse…
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-[7px]">
          <div className="flex items-center justify-between">
            <div className={fieldLabelClass}>SIMULATED NETWORKS</div>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={addNetwork}
              disabled={networks.length >= MAX_SIM_NETWORKS}
            >
              + Add network
            </Button>
          </div>

          {networks.map((network) => (
            <div key={network.key} className={draftBoxClass}>
              <div className="flex items-center gap-1.5">
                <select
                  value={network.kind}
                  onChange={(event) =>
                    updateNetwork(network.key, {
                      kind: event.target.value as NetworkInterfaceKind
                    })
                  }
                  aria-label="Network kind"
                  className={`${rowInputClass} shrink-0`}
                >
                  {KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={network.label}
                  onChange={(event) => updateNetwork(network.key, { label: event.target.value })}
                  aria-label="Network name"
                  className={`${rowInputClass} min-w-0 flex-1`}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => removeNetwork(network.key)}
                        disabled={networks.length <= 1}
                        focusableWhenDisabled
                        aria-label="Remove network"
                        className="text-destructive hover:text-destructive"
                      >
                        ×
                      </Button>
                    }
                  />
                  <TooltipContent>Remove network</TooltipContent>
                </Tooltip>
              </div>
              <div className="flex gap-2.5">
                <label className="flex flex-1 items-center gap-[5px] font-mono text-[10.5px] leading-none text-muted-foreground">
                  Speed
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={network.speedMbps}
                    onChange={(event) =>
                      updateNetwork(network.key, {
                        speedMbps: Number(event.target.value) || 1
                      })
                    }
                    className={`${rowInputClass} w-14`}
                  />
                  Mbps
                </label>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <label className="flex flex-1 items-center gap-[5px] font-mono text-[10.5px] leading-none text-muted-foreground">
                        Faults
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={network.faultRatePercent}
                          onChange={(event) =>
                            updateNetwork(network.key, {
                              faultRatePercent: Number(event.target.value) || 0
                            })
                          }
                          className={`${rowInputClass} w-12`}
                        />
                        %
                      </label>
                    }
                  />
                  <TooltipContent>
                    Chance a chunk attempt on this network fails outright, to exercise retry/error
                    handling
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-[5px]">
          <div id="devtools-connections-label" className={fieldLabelClass}>
            CONNECTIONS PER NETWORK
          </div>
          <ToggleGroup
            value={[String(connectionsPerNetwork)]}
            onValueChange={(values) => {
              if (values.length === 0) return
              setConnectionsPerNetwork(Number(values[0]))
            }}
            aria-labelledby="devtools-connections-label"
            variant="pill"
            size="xs"
            spacing={1}
          >
            {PRESET_CONNECTIONS.map((preset) => (
              <ToggleGroupItem key={preset} value={String(preset)}>
                {preset}×
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className={draftBoxClass}>
          <label className="flex cursor-pointer items-center gap-[7px] font-sans text-[11px] leading-[1.3] text-foreground">
            <input
              type="checkbox"
              checked={slowAssemble}
              onChange={(event) => setSlowAssemble(event.target.checked)}
            />
            Simulate the assembling step
          </label>
          <div className="font-sans text-[10.5px] leading-[1.4] text-muted-foreground">
            Reassembly normally finishes in a blink — this throttles it so the “assembling” screen
            (the block grid sweep, the pulsing combine line) stays on screen long enough to actually
            watch.
          </div>
          {slowAssemble && (
            <label className="flex items-center gap-[5px] font-mono text-[10.5px] leading-none text-muted-foreground">
              Assemble speed
              <input
                type="number"
                min={1}
                max={500}
                value={assembleSpeedMBps}
                onChange={(event) => setAssembleSpeedMBps(Number(event.target.value) || 1)}
                className={`${rowInputClass} w-14`}
              />
              MB/s
            </label>
          )}
        </div>

        {error && (
          <div className="font-sans text-[11.5px] leading-[1.4] text-destructive">⚠ {error}</div>
        )}

        <div className="flex justify-end gap-2">
          <DialogClose
            render={
              <Button type="button" variant="destructive">
                Cancel
              </Button>
            }
          />
          <Button type="button" onClick={handleStart} disabled={!canStart}>
            {starting ? 'Starting…' : 'Start simulated download'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
