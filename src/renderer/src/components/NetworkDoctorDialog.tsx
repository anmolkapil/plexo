import type { NetworkDoctorReport } from '@shared/types'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Check,
  Info,
  RefreshCw,
  ShieldAlert
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
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
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<NetworkDoctorReport | null>(null)

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

  const warnings = report?.issues.filter((i) => i.severity === 'warning') ?? []
  const infos = report?.issues.filter((i) => i.severity === 'info') ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-xl overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-base font-semibold">Windows Network Doctor</DialogTitle>
              <span className="rounded-full bg-foreground/10 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                Read-Only
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={handleRefresh}
              disabled={loading}
              title="Re-scan network status"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Diagnoses adapter metrics, simultaneous connection policies, and routing compatibility.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 text-xs">
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
                <p className="font-medium">Domain-Joined Device</p>
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
              {warnings.map((issue, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3.5 space-y-2"
                >
                  <p className="font-semibold text-foreground text-[12.5px]">{issue.title}</p>
                  <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {issue.detail}
                  </p>
                  {issue.recommendation && (
                    <div className="pt-1">
                      <p className="font-medium text-[11px] text-foreground">Suggested Fix:</p>
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
              ))}
            </div>
          )}

          {infos.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-[12px] text-muted-foreground flex items-center gap-1.5">
                <Info className="size-3.5" />
                Configuration Notes ({infos.length})
              </h4>
              {infos.map((issue, idx) => (
                <div
                  key={idx}
                  className="rounded-lg border border-border bg-foreground/[0.02] p-3.5 space-y-2"
                >
                  <p className="font-semibold text-foreground text-[12.5px]">{issue.title}</p>
                  <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">
                    {issue.detail}
                  </p>
                  {issue.recommendation && (
                    <div className="pt-1">
                      <p className="font-medium text-[11px] text-foreground">
                        Note / Recommendation:
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
              ))}
            </div>
          )}

          {report && report.issues.length === 0 && (
            <div className="flex flex-col items-center justify-center py-6 text-center space-y-2">
              <CheckCircle2 className="size-8 text-green-500" />
              <p className="font-medium text-foreground text-sm">No Network Conflicts Detected</p>
              <p className="text-muted-foreground max-w-sm text-xs">
                Windows is configured to allow simultaneous network connections. No subnet
                collisions or missing gateways were identified.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border px-5 py-3 bg-muted/30">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
