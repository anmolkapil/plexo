import { planDownload } from '@shared/plan'
import type { ProbeResult } from '@shared/types'
import { cn } from 'cn'
import { AlertTriangle, ClipboardPaste } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { NetworkCard } from '../components/NetworkCard'
import { ScreenFooter } from '../components/ScreenFooter'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group'
import { useNetworkPolling } from '../hooks/useNetworkPolling'
import { useAppStore } from '../store/useAppStore'
import { describeError, formatBytes, toDisplayPath } from '../utils/format'

type ProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ready'; result: ProbeResult }
  | { status: 'error'; message: string }

const PROBE_DEBOUNCE_MS = 600
const PRESET_STREAMS = [1, 2, 4, 8] as const

/** Peer counts, an order of magnitude above the HTTP stream presets. A BitTorrent peer serves
 * only while it chooses to unchoke you and most of a tracker's list is stale, so throughput
 * comes from holding many connections — a handful leaves a torrent crawling. */
const PRESET_PEERS = [10, 25, 50, 100] as const

const PASTE_SHORTCUT = window.plexo.platform === 'darwin' ? '⌘V' : 'Ctrl+V'

/** Matched in the renderer purely to word the UI — the main process does its own parsing and
 * is the one that decides what a link actually is. */
function looksLikeMagnet(value: string): boolean {
  return value.trim().toLowerCase().startsWith('magnet:')
}

const fieldLabelClass = 'shrink-0 font-mono text-[10px] tracking-[0.14em] text-muted-foreground'

function ErrorAlert({ message }: { message: string }): React.JSX.Element {
  return (
    <Alert variant="destructive" className="py-1.5">
      <AlertTriangle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

export function IdleScreen(): React.JSX.Element {
  useNetworkPolling(true)

  const interfaces = useAppStore((store) => store.interfaces)
  const homeDir = useAppStore((store) => store.homeDir)
  const downloadsDir = useAppStore((store) => store.downloadsDir)
  const latencies = useAppStore((store) => store.latencies)
  const url = useAppStore((store) => store.draftUrl)
  const setUrl = useAppStore((store) => store.setDraftUrl)
  const destinationDir = useAppStore((store) => store.draftDestinationDir)
  const setDestinationDir = useAppStore((store) => store.setDraftDestinationDir)

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' })
  // Tracks deselections rather than selections, so a newly-detected interface starts selected.
  const [deselectedInterfaceIds, setDeselectedInterfaceIds] = useState<string[]>([])
  const [chunksPerNetwork, setChunksPerNetwork] = useState(2)
  // Kept separate from the stream count rather than shared: the two are different quantities in
  // different units, so a user who picked 8 streams for an HTTP file can't carry that figure
  // onto a torrent, where it would mean eight peers.
  const [peersPerNetwork, setPeersPerNetwork] = useState(50)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [fileNameOverride, setFileNameOverride] = useState<string | null>(null)

  const probeRequestId = useRef(0)

  useEffect(() => {
    if (!destinationDir && downloadsDir) setDestinationDir(downloadsDir)
  }, [destinationDir, downloadsDir, setDestinationDir])

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
    setFileNameOverride(null)
    const timer = setTimeout(async () => {
      try {
        const result = await window.plexo.probeUrl(trimmed)
        if (probeRequestId.current !== requestId) return
        setProbe({ status: 'ready', result })
      } catch (error) {
        if (probeRequestId.current !== requestId) return
        setProbe({ status: 'error', message: describeError(error) })
      }
    }, PROBE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [url])

  const ready = probe.status === 'ready' ? probe.result : null
  const multiChunkAllowed = ready !== null && ready.supportsRanges && ready.totalBytes !== null
  const isSingleStreamOnly = ready !== null && !multiChunkAllowed

  const detectedIds = interfaces.map((iface) => iface.id)
  const enabledIds = detectedIds.filter((id) => !deselectedInterfaceIds.includes(id))
  const selectedInterfaceIds = isSingleStreamOnly ? enabledIds.slice(0, 1) : enabledIds

  // While probing there is no result to read a kind off yet, so the wording leans on the text
  // in the box; once resolved, the main process's answer takes over.
  const isMagnetInput = looksLikeMagnet(url)
  const torrent = ready?.torrent
  const isTorrent = isMagnetInput || Boolean(torrent)
  const streamsLabel = isTorrent ? 'PEERS / NETWORK' : 'PARALLEL STREAMS'
  const presets: readonly number[] = isTorrent ? PRESET_PEERS : PRESET_STREAMS
  const perNetwork = isTorrent ? peersPerNetwork : chunksPerNetwork
  const setPerNetwork = isTorrent ? setPeersPerNetwork : setChunksPerNetwork

  const connectionsPerNetwork = isSingleStreamOnly ? 1 : perNetwork
  // A small file gets fewer streams than asked for — one with no block to claim would only
  // idle — so once the file's size is known the count comes from the same plan the download
  // will use. A torrent's units are its pieces, which the HTTP planner knows nothing about, so
  // its slot count is simply what was asked for on each network.
  let totalChunks: number
  if (isTorrent) {
    totalChunks = selectedInterfaceIds.length * perNetwork
  } else if (ready) {
    totalChunks = planDownload({
      totalBytes: ready.totalBytes ?? 0,
      splittable: multiChunkAllowed,
      networkCount: selectedInterfaceIds.length,
      streamsPerNetwork: chunksPerNetwork
    }).streamNetworks.length
  } else {
    totalChunks = selectedInterfaceIds.length * chunksPerNetwork
  }

  let startLabel = 'Start'
  if (starting) startLabel = 'Starting…'
  // Resolving a magnet means asking the swarm for its metadata, which takes noticeably longer
  // than an HTTP probe — worth naming so the wait doesn't look like a hang.
  else if (probe.status === 'probing') startLabel = isMagnetInput ? 'Finding…' : 'Checking…'
  const canStart =
    probe.status === 'ready' &&
    selectedInterfaceIds.length > 0 &&
    Boolean(destinationDir) &&
    !starting
  const effectiveDestinationDir = destinationDir || downloadsDir
  const footerParts = [
    `${selectedInterfaceIds.length} ${selectedInterfaceIds.length === 1 ? 'network' : 'networks'} selected`
  ]
  if (selectedInterfaceIds.length > 0) {
    const unitWord = isTorrent
      ? totalChunks === 1
        ? 'peer connection'
        : 'peer connections'
      : totalChunks === 1
        ? 'stream'
        : 'parallel streams'
    footerParts.push(`${totalChunks} ${unitWord}`)
  }
  if (ready && ready.totalBytes !== null) footerParts.push(formatBytes(ready.totalBytes))

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
    const chosen = await window.plexo.chooseDestinationFolder(effectiveDestinationDir)
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
        kind: probe.result.kind,
        url: probe.result.finalUrl,
        destinationDir,
        suggestedFileName: fileNameOverride?.trim() || probe.result.suggestedFileName,
        totalBytes: probe.result.totalBytes ?? 0,
        supportsRanges: multiChunkAllowed,
        interfaceIds: selectedInterfaceIds,
        chunkCount: totalChunks,
        connectionsPerNetwork,
        etag: probe.result.etag,
        lastModified: probe.result.lastModified
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
              placeholder="https://… or magnet:?xt=urn:btih:…"
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

        {probe.status === 'probing' && isMagnetInput && (
          <p className="text-[11.5px] leading-[1.4] text-muted-foreground">
            Asking the swarm for this torrent&apos;s file list — a magnet link carries only an
            infohash, so there is nothing to show until a peer answers.
          </p>
        )}

        {torrent && (
          <p className="text-[11.5px] leading-[1.4] text-muted-foreground">
            Torrent · {torrent.pieceCount.toLocaleString()} pieces of{' '}
            {formatBytes(torrent.pieceLengthBytes)} ·{' '}
            {torrent.isSingleFile
              ? '1 file'
              : `${torrent.files.length.toLocaleString()} files in a folder`}
          </p>
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
          <div className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--text-secondary)]">
            {toDisplayPath(effectiveDestinationDir, homeDir)}
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

        <div
          className={cn(
            'flex min-h-9 items-center justify-between gap-3 rounded-[9px] border border-border px-3 py-1.5',
            isSingleStreamOnly && 'opacity-60'
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <div id="idle-streams-label" className={fieldLabelClass}>
              {streamsLabel}
            </div>
            <ToggleGroup
              value={[String(perNetwork)]}
              onValueChange={(values) => {
                if (values.length === 0) return
                setPerNetwork(Number(values[0]))
              }}
              disabled={isSingleStreamOnly}
              aria-labelledby="idle-streams-label"
              variant="pill"
              size="xs"
              spacing={1}
            >
              {presets.map((preset) => (
                // h-6/min-w-6: WCAG 2.5.8's 24px floor — the xs toggle size is 20px, and this is
                // the primary "how many parallel connections" control.
                <ToggleGroupItem key={preset} value={String(preset)} className="h-6 min-w-6">
                  {isTorrent ? preset : `${preset}×`}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div
            className={cn(
              'text-right font-mono text-[11px] whitespace-nowrap',
              isSingleStreamOnly ? 'text-muted-foreground' : 'text-[var(--text-secondary)]'
            )}
          >
            {isSingleStreamOnly ? (
              '1 stream (server does not support ranges)'
            ) : (
              <>
                <span className="font-semibold text-foreground">{perNetwork}</span> / network
                {selectedInterfaceIds.length > 0 && (
                  <>
                    {' · '}
                    <span className="font-semibold text-foreground">{totalChunks}</span>{' '}
                    {isTorrent
                      ? `total peer ${totalChunks === 1 ? 'connection' : 'connections'}`
                      : `total parallel ${totalChunks === 1 ? 'stream' : 'streams'}`}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {isSingleStreamOnly && (
          <div className="text-[11.5px] text-muted-foreground">
            This server doesn’t support multi-chunk downloads for this file — using a single
            network.
          </div>
        )}
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
