import { useCallback, useEffect, useState } from 'react'
import type {
  NetworkInterfaceInfo,
  SpeedComparisonProgress,
  SpeedComparisonReport
} from '@shared/types'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Gauge,
  Info,
  Play,
  RefreshCw,
  Square,
  Wifi,
  X,
  XCircle,
  Zap
} from 'lucide-react'
import { useNetworkVisuals } from '../hooks/useNetworkVisuals'
import { useAppStore } from '../store/useAppStore'
import { formatBytes, formatSpeed } from '../utils/format'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

interface SpeedComparisonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SpeedComparisonDialog({
  open,
  onOpenChange
}: SpeedComparisonDialogProps): React.JSX.Element {
  const interfaces = useAppStore((store) => store.interfaces)
  const speedUnit = useAppStore((store) => store.speedUnit)
  const networkVisual = useNetworkVisuals()

  const [deselectedIds, setDeselectedIds] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SpeedComparisonProgress | null>(null)
  const [report, setReport] = useState<SpeedComparisonReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const selectedIds = interfaces.filter((i) => !deselectedIds.includes(i.id)).map((i) => i.id)

  // Subscribe to progress events from the main process
  useEffect(() => {
    if (!open) return
    const unsubscribe = window.plexo.onSpeedComparisonProgress((p) => {
      setProgress(p)
    })
    return () => {
      unsubscribe()
    }
  }, [open])

  const handleToggleInterface = (id: string): void => {
    setDeselectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    )
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      if (running) {
        void window.plexo.cancelSpeedComparison()
      }
      setRunning(false)
      setProgress(null)
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  const handleStart = useCallback(() => {
    setRunning(true)
    setError(null)
    setReport(null)
    setProgress(null)

    window.plexo
      .startSpeedComparison(selectedIds)
      .then((res) => {
        setReport(res)
        setRunning(false)
      })
      .catch((err) => {
        if (err?.message !== 'Aborted' && err?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err))
        }
        setRunning(false)
      })
  }, [selectedIds])

  const handleCancel = useCallback(() => {
    void window.plexo.cancelSpeedComparison().finally(() => {
      setRunning(false)
      setProgress(null)
    })
  }, [])

  const handleCopy = useCallback(() => {
    if (!report) return
    const lines: string[] = ['# Plexo Network Speed Comparison Results', '']
    if (report.combinedResult && report.fastestIndividual) {
      lines.push(
        `• Combined Speed: ${formatSpeed(report.combinedResult.speedBytesPerSec, speedUnit)}`
      )
      lines.push(
        `• Fastest Single (${report.fastestIndividual.interfaceName}): ${formatSpeed(report.fastestIndividual.speedBytesPerSec, speedUnit)}`
      )
      if (report.speedupMultiplier) {
        lines.push(
          `• Acceleration Multiplier: ${report.speedupMultiplier}× (+${report.speedupPercent}%)`
        )
      }
      lines.push('')
    }

    lines.push('## Individual Network Speeds:')
    for (const ind of report.individualResults) {
      if (ind.status === 'completed') {
        const contrib = report.combinedResult?.contributions[ind.interfaceId]
        const contribStr = contrib ? ` (contributed ${contrib.percent}% in combined test)` : ''
        lines.push(
          `- ${ind.interfaceName}: ${formatSpeed(ind.speedBytesPerSec, speedUnit)}${contribStr}`
        )
      } else {
        lines.push(`- ${ind.interfaceName}: Unreachable (${ind.error || 'Failed to connect'})`)
      }
    }
    lines.push('')
    lines.push(`Assessment: ${report.assessmentNote}`)
    lines.push(`Total Data Downloaded: ${formatBytes(report.totalBytesUsed)}`)

    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [report, speedUnit])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[88vh] sm:max-w-xl overflow-hidden flex flex-col p-0 gap-0"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Gauge className="size-4 text-primary shrink-0" />
              <DialogTitle className="text-base font-semibold truncate">
                Compare Network Speeds
              </DialogTitle>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {report && !running && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleStart}
                  title="Run test again"
                  aria-label="Run test again"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw className="size-4" />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => handleOpenChange(false)}
                title="Close"
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
            Test each network individually, then measure combined throughput to verify
            multi-connection gain.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-xs">
          {/* 1. CONFIGURATION VIEW */}
          {!running && !report && (
            <div className="space-y-4">
              <div>
                <label className="text-[12px] font-medium text-foreground block mb-2">
                  Select Networks to Benchmark:
                </label>
                <div className="space-y-2 rounded-lg border border-border p-3 bg-foreground/[0.02]">
                  {interfaces.map((iface: NetworkInterfaceInfo) => {
                    const visual = networkVisual(iface.id, iface.kind, iface.displayName)
                    const checked = selectedIds.includes(iface.id)
                    const ip = iface.addresses.find((a) => a.family === 4)?.address ?? 'No IPv4'

                    return (
                      <div
                        key={iface.id}
                        onClick={() => handleToggleInterface(iface.id)}
                        className="flex items-center justify-between p-2 rounded-md hover:bg-foreground/[0.04] cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <Checkbox checked={checked} />
                          <span
                            className="size-2.5 rounded-full shrink-0"
                            style={{ background: visual.solid }}
                          />
                          <div>
                            <p className="font-medium text-foreground text-[12.5px]">
                              {visual.name}
                            </p>
                            <p className="text-[11px] text-muted-foreground font-mono">{ip}</p>
                          </div>
                        </div>
                        <span className="text-[11px] font-mono text-muted-foreground uppercase">
                          {iface.kind}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-foreground/[0.03] p-3 space-y-1.5 text-muted-foreground">
                <div className="flex items-center gap-2 text-foreground font-medium text-[11.5px]">
                  <Info className="size-3.5 text-primary" />
                  How the Benchmark Works
                </div>
                <p className="leading-relaxed">
                  • <strong>Fair Comparison:</strong> Keeps the total stream count constant across
                  individual and combined stages.
                </p>
                <p className="leading-relaxed">
                  • <strong>Warm-Up Period:</strong> Discards initial slow-start chunks so latency
                  doesn&apos;t skew throughput.
                </p>
                <p className="leading-relaxed">
                  • <strong>Safe &amp; Discarded:</strong> Downloads test chunks directly into
                  memory without writing files to disk.
                </p>
                <p className="leading-relaxed text-[11px] opacity-80 pt-1">
                  * Note: Benchmarking consumes ~15–35 MB per network. Ensure you have sufficient
                  data if using cellular tethering.
                </p>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive text-xs">
                  <XCircle className="size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}

          {/* 2. RUNNING PROGRESS VIEW */}
          {running && (
            <div className="py-6 space-y-6">
              <div className="text-center space-y-1.5">
                <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-primary text-xs font-medium">
                  <RefreshCw className="size-3 animate-spin" />
                  {progress
                    ? `Stage ${progress.stageIndex} of ${progress.totalStages}: ${progress.stageName}`
                    : 'Initializing benchmark...'}
                </div>
                <h3 className="text-2xl font-bold font-mono tracking-tight text-foreground pt-3">
                  {progress && progress.currentSpeedBytesPerSec > 0
                    ? formatSpeed(progress.currentSpeedBytesPerSec, speedUnit)
                    : '—'}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {progress?.phase === 'warming_up'
                    ? 'Warming up TCP connection (stabilizing latency)...'
                    : 'Measuring steady-state download throughput...'}
                </p>
              </div>

              {/* Progress bar */}
              <div className="space-y-1.5">
                <div className="h-2 w-full overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full bg-primary transition-all duration-200"
                    style={{ width: `${progress?.percent ?? 0}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground font-mono">
                  <span>Stage progress</span>
                  <span>{progress?.percent ?? 0}%</span>
                </div>
              </div>

              {/* Data usage counter */}
              <div className="flex items-center justify-between rounded-lg border border-border bg-foreground/[0.02] p-3 text-[11.5px]">
                <span className="text-muted-foreground">Data downloaded so far:</span>
                <span className="font-mono font-medium text-foreground">
                  {formatBytes(progress?.totalBytesUsedSoFar ?? 0)}
                </span>
              </div>
            </div>
          )}

          {/* 3. COMPLETED REPORT VIEW */}
          {!running && report && (
            <div className="space-y-4">
              {/* Top Hero Highlight */}
              {report.combinedResult && report.fastestIndividual ? (
                <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 text-center space-y-2">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-primary text-[11px] font-semibold font-mono">
                    <Zap className="size-3" />
                    {report.speedupMultiplier}× FASTER COMBINED (+{report.speedupPercent}%)
                  </div>
                  <div>
                    <h3 className="text-3xl font-extrabold font-mono text-foreground tracking-tight">
                      {formatSpeed(report.combinedResult.speedBytesPerSec, speedUnit)}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Combined speed vs{' '}
                      {formatSpeed(report.fastestIndividual.speedBytesPerSec, speedUnit)} (fastest
                      single: {report.fastestIndividual.interfaceName})
                    </p>
                  </div>
                </div>
              ) : report.fastestIndividual ? (
                <div className="rounded-xl border border-border bg-foreground/[0.03] p-4 text-center space-y-1">
                  <p className="text-xs text-muted-foreground">Single Network Speed:</p>
                  <h3 className="text-2xl font-bold font-mono text-foreground">
                    {formatSpeed(report.fastestIndividual.speedBytesPerSec, speedUnit)}
                  </h3>
                </div>
              ) : null}

              {/* Assessment Message */}
              <div
                className={`flex items-start gap-2.5 rounded-lg border p-3 ${
                  report.assessment === 'significant_gain'
                    ? 'border-green-500/30 bg-green-500/10 text-green-900 dark:text-green-200'
                    : report.assessment === 'moderate_gain'
                      ? 'border-blue-500/30 bg-blue-500/10 text-blue-900 dark:text-blue-200'
                      : report.assessment === 'no_gain'
                        ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
                        : 'border-border bg-foreground/[0.02] text-foreground'
                }`}
              >
                {report.assessment === 'significant_gain' ? (
                  <CheckCircle2 className="size-4 shrink-0 mt-0.5 text-green-600 dark:text-green-400" />
                ) : report.assessment === 'no_gain' ? (
                  <AlertTriangle className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                ) : (
                  <Info className="size-4 shrink-0 mt-0.5 text-primary" />
                )}
                <div>
                  <p className="font-semibold text-[11.5px]">Diagnosis:</p>
                  <p className="text-[11.5px] opacity-90 leading-relaxed">
                    {report.assessmentNote}
                  </p>
                </div>
              </div>

              {/* Breakdown Table */}
              <div className="space-y-2">
                <h4 className="font-medium text-[12px] text-foreground flex items-center gap-1.5">
                  <Wifi className="size-3.5" />
                  Network Breakdown
                </h4>
                <div className="rounded-lg border border-border overflow-hidden">
                  <div className="grid grid-cols-12 bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground border-b border-border">
                    <span className="col-span-5">Network</span>
                    <span className="col-span-4 text-right">Individual Speed</span>
                    <span className="col-span-3 text-right">Combined Share</span>
                  </div>
                  {report.individualResults.map((res) => {
                    const iface = interfaces.find((i) => i.id === res.interfaceId)
                    const visual = iface
                      ? networkVisual(iface.id, iface.kind, iface.displayName)
                      : null
                    const contrib = report.combinedResult?.contributions[res.interfaceId]

                    return (
                      <div
                        key={res.interfaceId}
                        className="grid grid-cols-12 items-center px-3 py-2.5 border-b border-border last:border-none text-[12px]"
                      >
                        <div className="col-span-5 flex items-center gap-2">
                          {visual && (
                            <span
                              className="size-2 rounded-full shrink-0"
                              style={{ background: visual.solid }}
                            />
                          )}
                          <span className="font-medium truncate">{res.interfaceName}</span>
                        </div>
                        <div className="col-span-4 text-right font-mono font-medium">
                          {res.status === 'completed' ? (
                            formatSpeed(res.speedBytesPerSec, speedUnit)
                          ) : (
                            <span className="text-destructive text-[11px]">Unreachable</span>
                          )}
                        </div>
                        <div className="col-span-3 text-right font-mono text-muted-foreground">
                          {contrib ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <span>{contrib.percent}%</span>
                              <div className="w-10 h-1.5 rounded-full bg-foreground/10 overflow-hidden shrink-0">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${contrib.percent}%`,
                                    background: visual?.solid ?? 'var(--color-primary)'
                                  }}
                                />
                              </div>
                            </div>
                          ) : (
                            '—'
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* Total data downloaded info */}
              <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1">
                <span>Total data transferred for benchmark:</span>
                <span className="font-mono font-medium text-foreground">
                  {formatBytes(report.totalBytesUsed)}
                </span>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="m-0 border-t border-border px-5 py-3 bg-muted/30 flex items-center justify-between sm:justify-between rounded-b-xl">
          {running ? (
            <>
              <span className="text-xs text-muted-foreground animate-pulse">
                Benchmark in progress...
              </span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                className="gap-1.5"
              >
                <Square className="size-3.5 fill-current" />
                Cancel
              </Button>
            </>
          ) : report ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="gap-1.5"
              >
                {copied ? (
                  <Check className="size-3.5 text-green-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? 'Copied' : 'Copy Summary'}
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Close
                </Button>
                <Button type="button" size="sm" onClick={handleStart} className="gap-1.5">
                  <RefreshCw className="size-3.5" />
                  Test Again
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleStart}
                disabled={selectedIds.length === 0}
                className="gap-1.5"
              >
                <Play className="size-3.5 fill-current" />
                Start Comparison
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
