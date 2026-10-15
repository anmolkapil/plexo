import type { NetworkDoctorIssue, NetworkDoctorReport } from '@shared/types'
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { cn } from 'cn'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'

interface NetworkDoctorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function CopyableSnippet({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [text])

  return (
    <div className="relative mt-1.5 flex items-start justify-between rounded-md border border-border bg-foreground/5 p-2 font-mono text-[11px] text-foreground">
      <code className="overflow-x-auto whitespace-pre-wrap break-all pr-6">{text}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="ml-2 inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
        title="Copy to clipboard"
      >
        {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

export function NetworkDoctorDialog({
  open,
  onOpenChange
}: NetworkDoctorDialogProps): React.JSX.Element {
  const setNetworkPreference = useAppStore((store) => store.setNetworkPreference)
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<NetworkDoctorReport | null>(null)
  const [pendingConsentIssue, setPendingConsentIssue] = useState<NetworkDoctorIssue | null>(null)
  const [applyingFix, setApplyingFix] = useState(false)
  const [fixFeedback, setFixFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)
  const [expandedTechnicalIssues, setExpandedTechnicalIssues] = useState<Record<string, boolean>>(
    {}
  )

  const handleRefresh = useCallback(() => {
    setLoading(true)
    window.plexo
      .getNetworkDoctorReport(true)
      .then((res) => setReport(res))
      .catch((err) => console.error('[plexo] doctor failed', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!open) return
    let active = true
    window.plexo
      .getNetworkDoctorReport()
      .then((res) => {
        if (active) setReport(res)
      })
      .catch((err) => console.error('[plexo] doctor failed', err))
    return () => {
      active = false
    }
  }, [open])

  const handleApplySystemFix = async (issue: NetworkDoctorIssue): Promise<void> => {
    if (!issue.fix || issue.fix.action !== 'system') return
    setApplyingFix(true)
    setFixFeedback(null)
    try {
      const res = await window.plexo.applyNetworkDoctorFix({
        type: issue.fix.type as 'enableSimultaneousConnections' | 'setInterfaceMetric',
        interfaceIndex: issue.fix.interfaceIndex
      })
      if (res.success) {
        setFixFeedback({
          type: 'success',
          message: 'Setting applied successfully! Re-scanning network status...'
        })
        setPendingConsentIssue(null)
        handleRefresh()
      } else {
        setFixFeedback({
          type: 'error',
          message: res.error || 'Failed to apply setting.'
        })
      }
    } catch (err: unknown) {
      setFixFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setApplyingFix(false)
    }
  }

  const handlePlexoFix = (issue: NetworkDoctorIssue): void => {
    if (issue.fix?.interfaceId) {
      setNetworkPreference(issue.fix.interfaceId, { off: true })
      setFixFeedback({
        type: 'success',
        message: `"${issue.interfaceName ?? 'Network'}" turned off in Plexo.`
      })
      setTimeout(() => {
        handleRefresh()
      }, 500)
    }
  }

  const toggleTechnical = (key: string): void => {
    setExpandedTechnicalIssues((prev) => ({
      ...prev,
      [key]: !prev[key]
    }))
  }

  const warnings = report?.issues.filter((i) => i.severity === 'warning') ?? []
  const infos = report?.issues.filter((i) => i.severity === 'info') ?? []
  const hasIssues = warnings.length > 0 || infos.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[85vh] sm:max-w-xl overflow-hidden flex flex-col p-0 gap-0"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Activity className="size-4 text-primary shrink-0" />
              <DialogTitle className="text-base font-semibold truncate">
                Windows Network Doctor
              </DialogTitle>
              {report ? (
                warnings.length > 0 ? (
                  <span className="rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 px-2 py-0.5 font-medium text-[10.5px]">
                    Needs Attention
                  </span>
                ) : infos.length > 0 ? (
                  <span className="rounded-full bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 font-medium text-[10.5px]">
                    Optimization Available
                  </span>
                ) : (
                  <span className="rounded-full bg-green-500/10 text-green-700 dark:text-green-300 border border-green-500/20 px-2 py-0.5 font-medium text-[10.5px]">
                    Ready
                  </span>
                )
              ) : (
                <span className="rounded-full bg-muted text-muted-foreground border border-border px-2 py-0.5 font-medium text-[10.5px]">
                  Scanning...
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleRefresh}
                disabled={loading}
                title="Re-scan network status"
                aria-label="Re-scan network status"
                className="text-muted-foreground hover:text-foreground"
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onOpenChange(false)}
                title="Close"
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
            Diagnoses adapter metrics, simultaneous connection policies, and routing compatibility.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-xs">
          {/* User Consent Card for System Settings */}
          {pendingConsentIssue && (
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3 animate-in fade-in duration-150">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-primary/15 p-2 text-primary shrink-0 mt-0.5">
                  <ShieldCheck className="size-4" />
                </div>
                <div className="space-y-1 min-w-0 flex-1">
                  <h4 className="font-semibold text-foreground text-[13px]">
                    Permission Required: {pendingConsentIssue.fix?.label}
                  </h4>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {pendingConsentIssue.fix?.description}
                  </p>
                  <p className="text-[11px] text-muted-foreground/80 pt-0.5">
                    Windows will display an administrator permission prompt (User Account Control)
                    to confirm this change.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-primary/15">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPendingConsentIssue(null)
                    setFixFeedback(null)
                  }}
                  disabled={applyingFix}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleApplySystemFix(pendingConsentIssue)}
                  disabled={applyingFix}
                  className="gap-1.5"
                >
                  {applyingFix ? (
                    <>
                      <RefreshCw className="size-3.5 animate-spin" />
                      Applying...
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-3.5" />
                      Allow &amp; Apply Setting
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Inline Action Feedback */}
          {fixFeedback && (
            <div
              className={cn(
                'flex items-center justify-between rounded-lg p-3 text-xs border',
                fixFeedback.type === 'success'
                  ? 'border-green-500/30 bg-green-500/10 text-green-900 dark:text-green-200'
                  : 'border-destructive/30 bg-destructive/10 text-destructive'
              )}
            >
              <div className="flex items-center gap-2">
                {fixFeedback.type === 'success' ? (
                  <CheckCircle2 className="size-4 shrink-0 text-green-600 dark:text-green-400" />
                ) : (
                  <AlertTriangle className="size-4 shrink-0" />
                )}
                <span>{fixFeedback.message}</span>
              </div>
              <button
                type="button"
                onClick={() => setFixFeedback(null)}
                className="text-current opacity-70 hover:opacity-100 ml-2"
                aria-label="Dismiss message"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {loading && !report && (
            <div className="flex flex-col items-center justify-center py-10 text-center space-y-2">
              <RefreshCw className="size-6 animate-spin text-muted-foreground" />
              <p className="text-muted-foreground text-xs">
                Scanning Windows network configuration...
              </p>
            </div>
          )}

          {report && !report.supported && (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
              <Info className="size-6 text-muted-foreground" />
              <p className="font-medium text-foreground text-sm">Windows-Only Diagnostic</p>
              <p className="text-muted-foreground max-w-sm text-xs">
                Network Doctor diagnostics are only applicable to Windows operating systems.
              </p>
            </div>
          )}

          {report?.partOfDomain && (
            <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
              <ShieldAlert className="size-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium">Work or School Managed PC</p>
                <p className="text-[11.5px] opacity-90">
                  This computer is joined to an Active Directory domain. Network policies and
                  simultaneous connection rules may be managed by your organization.
                </p>
              </div>
            </div>
          )}

          {report?.defaultRouteOwner && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-foreground/[0.03] px-3.5 py-2.5">
              <span className="text-muted-foreground">Default Internet Route:</span>
              <span className="font-mono text-[12px] font-medium text-foreground">
                {report.defaultRouteOwner.interfaceName}{' '}
                <span className="text-muted-foreground font-normal">
                  (Metric: {report.defaultRouteOwner.metric}
                  {report.defaultRouteOwner.nextHop
                    ? ` via ${report.defaultRouteOwner.nextHop}`
                    : ''}
                  )
                </span>
              </span>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-[12px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <AlertTriangle className="size-3.5" />
                Attention Needed ({warnings.length})
              </h4>
              {warnings.map((issue, idx) => {
                const key = `warning-${idx}`
                const isExpanded = expandedTechnicalIssues[key] ?? false

                return (
                  <div
                    key={key}
                    className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3.5 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-foreground text-[12.5px]">
                            {issue.title}
                          </p>
                          {issue.fix && (
                            <span className="rounded-full bg-amber-500/20 text-amber-800 dark:text-amber-200 px-2 py-0.5 text-[10px] font-medium">
                              Fix Available
                            </span>
                          )}
                        </div>
                        {issue.summary && (
                          <p className="text-foreground/90 font-normal leading-relaxed text-xs">
                            {issue.summary}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Action Button */}
                    {issue.fix && (
                      <div className="pt-0.5">
                        {issue.fix.action === 'system' ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              setFixFeedback(null)
                              setPendingConsentIssue(issue)
                            }}
                            className="gap-1.5 text-xs"
                          >
                            <Wrench className="size-3.5" />
                            {issue.fix.label}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handlePlexoFix(issue)}
                            className="gap-1.5 text-xs"
                          >
                            <Check className="size-3.5" />
                            {issue.fix.label}
                          </Button>
                        )}
                      </div>
                    )}

                    {/* Collapsible Technical Details / Manual Snippet */}
                    <div className="border-t border-amber-500/20 pt-2">
                      <button
                        type="button"
                        onClick={() => toggleTechnical(key)}
                        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronUp className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                        <span>
                          {isExpanded
                            ? 'Hide technical details'
                            : 'View technical details & manual fix'}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="mt-2 space-y-2 text-[11.5px] text-muted-foreground bg-foreground/[0.03] p-3 rounded-md border border-border/60">
                          <p className="leading-relaxed whitespace-pre-wrap">{issue.detail}</p>
                          {issue.recommendation && (
                            <div className="pt-1.5">
                              <p className="font-medium text-[11px] text-foreground">
                                Manual Command / Recommendation:
                              </p>
                              {issue.recommendation.includes('reg add') ||
                              issue.recommendation.includes('Set-NetIPInterface') ? (
                                <CopyableSnippet text={issue.recommendation} />
                              ) : (
                                <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">
                                  {issue.recommendation}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {infos.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-[12px] text-muted-foreground flex items-center gap-1.5">
                <Info className="size-3.5" />
                Configuration Notes &amp; Recommendations ({infos.length})
              </h4>
              {infos.map((issue, idx) => {
                const key = `info-${idx}`
                const isExpanded = expandedTechnicalIssues[key] ?? false

                return (
                  <div
                    key={key}
                    className="rounded-lg border border-border bg-foreground/[0.02] p-3.5 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-foreground text-[12.5px]">
                            {issue.title}
                          </p>
                          {issue.fix && (
                            <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium">
                              Fix Available
                            </span>
                          )}
                        </div>
                        {issue.summary && (
                          <p className="text-foreground/90 font-normal leading-relaxed text-xs">
                            {issue.summary}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Action Button */}
                    {issue.fix && (
                      <div className="pt-0.5">
                        {issue.fix.action === 'system' ? (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                              setFixFeedback(null)
                              setPendingConsentIssue(issue)
                            }}
                            className="gap-1.5 text-xs"
                          >
                            <Wrench className="size-3.5" />
                            {issue.fix.label}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handlePlexoFix(issue)}
                            className="gap-1.5 text-xs"
                          >
                            <Check className="size-3.5" />
                            {issue.fix.label}
                          </Button>
                        )}
                      </div>
                    )}

                    {/* Collapsible Technical Details / Manual Snippet */}
                    <div className="border-t border-border/50 pt-2">
                      <button
                        type="button"
                        onClick={() => toggleTechnical(key)}
                        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronUp className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                        <span>
                          {isExpanded
                            ? 'Hide technical details'
                            : 'View technical details & manual fix'}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="mt-2 space-y-2 text-[11.5px] text-muted-foreground bg-foreground/[0.03] p-3 rounded-md border border-border/60">
                          <p className="leading-relaxed whitespace-pre-wrap">{issue.detail}</p>
                          {issue.recommendation && (
                            <div className="pt-1.5">
                              <p className="font-medium text-[11px] text-foreground">
                                Manual Command / Recommendation:
                              </p>
                              {issue.recommendation.includes('reg add') ||
                              issue.recommendation.includes('Set-NetIPInterface') ? (
                                <CopyableSnippet text={issue.recommendation} />
                              ) : (
                                <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">
                                  {issue.recommendation}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {report && !hasIssues && (
            <div className="flex flex-col items-center justify-center py-8 text-center space-y-2">
              <CheckCircle2 className="size-8 text-green-500" />
              <p className="font-medium text-foreground text-sm">
                All Network Settings are Optimal
              </p>
              <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
                Windows is configured to allow simultaneous network connections. No subnet
                collisions or missing gateways were identified.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="m-0 border-t border-border px-5 py-3 bg-muted/30 flex items-center justify-between sm:justify-between rounded-b-xl">
          <span className="text-[11.5px] text-muted-foreground">
            {report
              ? warnings.length > 0
                ? `${warnings.length} issue${warnings.length > 1 ? 's' : ''} need attention`
                : infos.length > 0
                  ? `${infos.length} recommendation${infos.length > 1 ? 's' : ''} available`
                  : 'All settings verified'
              : 'Scanning network configuration...'}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
