import type { DownloadState } from '@shared/types'
import { useState } from 'react'
import { ScreenFooter } from '../components/ScreenFooter'
import { TruncatedText } from '../components/TruncatedText'
import { Button } from '../components/ui/button'
import { describeError, fileExtensionBadge, formatBytes } from '../utils/format'

export function ErrorScreen({
  download,
  onNewDownload,
  onDownloadAgain
}: {
  download: DownloadState
  onNewDownload: () => void
  onDownloadAgain: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const cancelled = download.status === 'cancelled'
  const knownSize = download.totalBytes > 0
  const percent = knownSize
    ? Math.min(100, Math.round((download.bytesDownloaded / download.totalBytes) * 100))
    : 0
  const heading = cancelled ? 'Download Cancelled' : 'Download Failed'
  const description = cancelled
    ? 'The download was stopped before finishing.'
    : download.error
      ? describeError(download.error)
      : 'An error occurred during transfer.'

  const handleCopyUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(download.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard write failures
    }
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-1 flex-col items-center justify-center px-5 py-6">
        <div className="flex w-full max-w-[440px] flex-col items-center gap-[18px] rounded-[14px] border-[0.5px] border-[var(--border-strong)] bg-card p-[28px_24px] text-center shadow-[0_16px_40px_rgba(0,0,0,0.45),0_2px_8px_rgba(0,0,0,0.2)]">
          {/* Status Icon */}
          <div
            className={`flex size-12 shrink-0 items-center justify-center rounded-full border ${
              cancelled
                ? 'border-[var(--color-usb-border)] bg-[var(--color-usb-bg)]'
                : 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)]'
            }`}
          >
            {cancelled ? (
              <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="var(--color-usb-text)"
                  strokeWidth="2"
                />
                <line
                  x1="8"
                  y1="12"
                  x2="16"
                  y2="12"
                  stroke="var(--color-usb-text)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  className="stroke-destructive"
                  strokeWidth="2"
                />
                <line
                  x1="12"
                  y1="8"
                  x2="12"
                  y2="12.5"
                  className="stroke-destructive"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="15.5" r="1.2" className="fill-destructive" />
              </svg>
            )}
          </div>

          {/* Heading */}
          <div role="alert" className="flex flex-col gap-[5px]">
            <div className="font-sans text-[17px] leading-[1.2] font-bold text-foreground">
              {heading}
            </div>
            <div className="font-sans text-[12px] leading-[1.4] text-[var(--text-secondary)]">
              {description}
            </div>
          </div>

          {/* File capsule */}
          <div className="flex w-full items-center gap-[11px] rounded-[9px] border-[0.5px] border-border bg-background p-[10px_12px] text-left">
            <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[7px] border-[0.5px] border-[var(--border-strong)] bg-card font-mono text-[8.5px] leading-none font-semibold text-[var(--text-secondary)]">
              {fileExtensionBadge(download.fileName)}
            </div>
            <div className="min-w-0 flex-1">
              <TruncatedText
                text={download.fileName}
                className="font-sans text-[12.5px] leading-[1.3] font-semibold text-foreground"
              />
              <div className="mt-0.5 font-mono text-[11px] leading-none tabular-nums text-muted-foreground">
                {download.bytesDownloaded > 0 ? (
                  <>
                    {formatBytes(download.bytesDownloaded)}
                    {knownSize
                      ? ` of ${formatBytes(download.totalBytes)} (${percent}%)`
                      : ' transferred'}
                  </>
                ) : (
                  'No data transferred'
                )}
              </div>
            </div>
          </div>

          {/* Action Buttons in Center */}
          <div className="mt-1 flex w-full justify-center gap-2.5">
            <Button type="button" onClick={onDownloadAgain}>
              Download Again
            </Button>
            <Button type="button" variant="secondary" onClick={onNewDownload}>
              New Download
            </Button>
          </div>
        </div>
      </div>

      {/* Footer with properly constrained, non-overflowing URL */}
      <ScreenFooter className="min-w-0">
        <div className="min-w-0 flex-1 font-mono text-[11px] leading-none text-muted-foreground">
          <TruncatedText text={download.url} />
        </div>
        <button
          type="button"
          onClick={handleCopyUrl}
          className={`min-h-6 shrink-0 border-none bg-transparent px-1 py-0.5 font-mono text-[11px] leading-none ${
            copied ? 'text-[var(--color-success)]' : 'text-primary'
          }`}
        >
          {copied ? 'Copied' : 'Copy URL'}
        </button>
      </ScreenFooter>
    </div>
  )
}
