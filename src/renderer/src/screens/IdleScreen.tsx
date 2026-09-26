import type { ProbeResult } from '@shared/types'
import { cn } from 'cn'
import { AlertTriangle, ClipboardPaste, Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NetworkCard } from '../components/NetworkCard'
import { ScreenFooter } from '../components/ScreenFooter'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { useLatencyPolling } from '../hooks/useNetworks'
import { useAppStore } from '../store/useAppStore'
import { describeError, formatBytes, toDisplayPath } from '../utils/format'

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; result: ProbeResult }
  | { status: 'error'; message: string }

const PROBE_DEBOUNCE_MS = 600
const PASTE_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘V' : 'Ctrl+V'

const fieldLabelClass = 'shrink-0 font-mono text-[10px] tracking-[0.14em] text-muted-foreground'

function ErrorAlert({ message }: { message: string }): React.JSX.Element {
  return (
    <Alert variant="destructive" className="py-1.5">
      <AlertTriangle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function WarningAlert({ title, message }: { title?: string; message: string }): React.JSX.Element {
  return (
    <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 py-2">
      <AlertTriangle className="text-amber-600 dark:text-amber-400" />
      {title && <AlertTitle className="text-xs font-semibold">{title}</AlertTitle>}
      <AlertDescription className="text-xs text-amber-800 dark:text-amber-200/90 leading-relaxed">
        {message}
      </AlertDescription>
    </Alert>
  )
}

function InfoAlert({ title, message }: { title?: string; message: string }): React.JSX.Element {
  return (
    <Alert className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300 py-2">
      <Info className="text-blue-600 dark:text-blue-400" />
      {title && <AlertTitle className="text-xs font-semibold">{title}</AlertTitle>}
      <AlertDescription className="text-xs text-blue-800 dark:text-blue-200/90 leading-relaxed">
        {message}
      </AlertDescription>
    </Alert>
  )
}

export function IdleScreen(): React.JSX.Element {
  useLatencyPolling()

  const interfaces = useAppStore((store) => store.interfaces)
  const homeDir = useAppStore((store) => store.homeDir)
  const latencies = useAppStore((store) => store.latencies)
  const url = useAppStore((store) => store.draftUrl)
  const setUrl = useAppStore((store) => store.setDraftUrl)
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const headers = useAppStore((store) => store.draftHeaders)
  const companionFileName = useAppStore((store) => store.draftFileName)

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  // Tracks deselections rather than selections, so a newly-detected interface starts selected.
  const [deselectedInterfaceIds, setDeselectedInterfaceIds] = useState<string[]>([])
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null)

  const probeRequestId = useRef(0)

  useEffect(() => {
    const trimmed = url.trim()
    if (!trimmed) {
      // Resetting derived probe state when its trigger (the URL) is cleared.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProbe({ status: 'idle' })
      setFileNameOverride(null)
      return
    }

    const requestId = ++probeRequestId.current
    setProbe({ status: 'probing' })
    if (companionFileName) {
      setFileNameOverride(companionFileName)
    } else {
      setFileNameOverride(null)
    }
    const timer = setTimeout(async () => {
      try {
        const result = await window.plexo.probeUrl(trimmed, headers)
        if (probeRequestId.current !== requestId) return
        setProbe({ status: 'ready', result })
      } catch (error) {
        if (probeRequestId.current !== requestId) return
        setProbe({ status: 'error', message: describeError(error) })
      }
    }, PROBE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [url, headers, companionFileName])

  const ready = probe.status === 'ready' ? probe.result : null
  const multiChunkAllowed = ready !== null && ready.supportsRanges && ready.totalBytes !== null
  const isSingleStreamOnly = ready !== null && !multiChunkAllowed
  // One request has to carry the whole file: either the server can't serve parts of it, or it
  // didn't say how big it is, so there's no telling where the parts would be.
  const sizeUnknown = isSingleStreamOnly && ready.supportsRanges

  const detectedIds = interfaces.map((iface) => iface.id)
  const enabledIds = detectedIds.filter((id) => !deselectedInterfaceIds.includes(id))
  const selectedInterfaceIds = isSingleStreamOnly ? enabledIds.slice(0, 1) : enabledIds

  const startLabel = starting ? 'Starting…' : probe.status === 'probing' ? 'Checking…' : 'Start'
  const canStart =
    probe.status === 'ready' &&
    selectedInterfaceIds.length > 0 &&
    Boolean(destinationDir) &&
    !starting
  const footerParts = [
    `${selectedInterfaceIds.length} ${selectedInterfaceIds.length === 1 ? 'network' : 'networks'} selected`
  ]
  // How many streams each network gets is worked out during the download; the one case worth
  // saying up front is a server that can't split the file at all.
  if (isSingleStreamOnly) {
    footerParts.push(
      sizeUnknown
        ? '1 stream: the file’s size isn’t known'
        : '1 stream: the server can’t split this file'
    )
  }
  if (ready && ready.totalBytes !== null) footerParts.push(formatBytes(ready.totalBytes))

  let subnetConflict: { subnet: string; names: string[] } | null = null
  if (selectedInterfaceIds.length > 1) {
    const subnets = new Map<string, string[]>()
    for (const id of selectedInterfaceIds) {
      const iface = interfaces.find((i) => i.id === id)
      const subnet = iface?.addresses.find((address) => address.family === 4)?.subnet
      if (subnet) {
        const names = subnets.get(subnet) ?? []
        names.push(iface.displayName)
        subnets.set(subnet, names)
      }
    }
    for (const [subnet, names] of subnets.entries()) {
      if (names.length > 1) {
        subnetConflict = { subnet, names }
        break
      }
    }
  }

  const handleToggleInterface = (id: string): void => {
    if (isSingleStreamOnly) {
      // Single-stream mode can only download through 1 interface at a time
      setDeselectedInterfaceIds(detectedIds.filter((otherId) => otherId !== id))
      return
    }

    setDeselectedInterfaceIds((prev) => {
      const isCurrentlySelected = !prev.includes(id)
      if (isCurrentlySelected) {
        // Deselecting: keep at least 1 interface selected
        const remainingCount = detectedIds.filter(
          (otherId) => !prev.includes(otherId) && otherId !== id
        ).length
        if (remainingCount === 0) return prev
        return [...prev, id]
      } else {
        return prev.filter((entry) => entry !== id)
      }
    })
  }

  const handleBrowse = async (): Promise<void> => {
    const chosen = await window.plexo.chooseDestinationFolder(destinationDir)
    if (chosen) setDestinationDir(chosen)
  }

  const handlePaste = async (): Promise<void> => {
    const text = await window.plexo.readClipboardText()
    if (text.trim()) setUrl(text.trim())
  }

  const handleStart = async (): Promise<void> => {
    if (probe.status !== 'ready' || !canStart) return
    setStarting(true)
    setStartError(null)
    try {
      await window.plexo.startDownload({
        url: probe.result.finalUrl,
        destinationDir,
        suggestedFileName: fileNameOverride?.trim() || probe.result.suggestedFileName,
        totalBytes: probe.result.totalBytes ?? 0,
        supportsRanges: multiChunkAllowed,
        interfaceIds: selectedInterfaceIds,
        etag: probe.result.etag,
        lastModified: probe.result.lastModified,
        headers
      })
    } catch (error) {
      setStartError(describeError(error))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-col gap-[9px] px-5 pt-4 pb-3.5">
        <div className="flex items-center gap-[9px]">
          <div
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-[9px] rounded-[9px] border bg-[var(--input-bg)] px-3',
              probe.status === 'error' ? 'border-destructive' : 'border-input'
            )}
          >
            <div id="idle-link-label" className={fieldLabelClass}>
              LINK
            </div>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              spellCheck={false}
              aria-labelledby="idle-link-label"
              className="min-w-0 flex-1 rounded-[3px] border-none bg-transparent font-mono text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={handlePaste}
              className="shrink-0 font-mono text-[9.5px] uppercase tracking-wide"
            >
              <ClipboardPaste data-icon="inline-start" />
              Paste {PASTE_SHORTCUT}
            </Button>
          </div>
          <Button
            type="button"
            onClick={handleStart}
            disabled={!canStart}
            className="h-9 w-28 shrink-0"
          >
            {startLabel}
          </Button>
        </div>

        {probe.status === 'error' && <ErrorAlert message={probe.message} />}

        {isSingleStreamOnly && (
          <InfoAlert
            title="Single-connection mode"
            message={
              sizeUnknown
                ? 'The server didn’t say how big this file is, so it can’t be split into parts. The download will run as a single stream through whichever network you choose below.'
                : 'This server does not support parallel range requests (206 Partial Content). The download will run as a single stream through whichever network you choose below.'
            }
          />
        )}

        {subnetConflict && (
          <WarningAlert
            title="Same local network detected"
            message={`${subnetConflict.names.join(' and ')} are connected to the same subnet (${subnetConflict.subnet}). The operating system routes all traffic through one connection on the same subnet, so speeds cannot be combined. Connect to distinct networks (e.g. Wi-Fi + phone USB tethering) to combine bandwidth.`}
          />
        )}

        <div
          className={cn(
            'flex h-9 items-center gap-[9px] rounded-[9px] border px-3',
            ready ? 'border-border opacity-100' : 'border-dashed border-border opacity-50'
          )}
        >
          <div id="idle-saveas-label" className={fieldLabelClass}>
            SAVE AS
          </div>
          <input
            type="text"
            value={ready ? (fileNameOverride ?? ready.suggestedFileName) : ''}
            onChange={(event) => setFileNameOverride(event.target.value)}
            disabled={!ready}
            placeholder="—"
            aria-labelledby="idle-saveas-label"
            className="min-w-0 flex-1 rounded-[3px] border-none bg-transparent font-mono text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
          {ready && ready.totalBytes !== null && (
            <div className="shrink-0 whitespace-nowrap font-mono text-[11px] font-medium text-muted-foreground">
              {formatBytes(ready.totalBytes)} (est.)
            </div>
          )}
        </div>

        <div className="flex h-9 items-center gap-[9px] rounded-[9px] border border-border px-3">
          <div className={fieldLabelClass}>TO</div>
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px] leading-normal text-[var(--text-secondary)]">
            {toDisplayPath(destinationDir, homeDir)}
          </div>
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={handleBrowse}
            className="h-auto shrink-0 px-0 font-mono text-[11px]"
          >
            Browse…
          </Button>
        </div>

        {startError && <ErrorAlert message={startError} />}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-3.5">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <h2 className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">
            Connected Networks
          </h2>
          <div className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {interfaces.length} detected · {selectedInterfaceIds.length} selected
          </div>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-2.5 pt-3">
          {interfaces.map((iface) => (
            <NetworkCard
              key={iface.id}
              iface={iface}
              selected={selectedInterfaceIds.includes(iface.id)}
              latencyMs={latencies[iface.id]}
              onToggle={() => handleToggleInterface(iface.id)}
            />
          ))}
        </div>
      </div>

      <ScreenFooter className="gap-2.5">
        <div className="font-mono text-[11px] text-muted-foreground">{footerParts.join(' · ')}</div>
      </ScreenFooter>
    </div>
  )
}
