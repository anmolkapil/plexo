import type { DownloadState, TorrentTrackersResult } from '@shared/types'
import { parseTrackerList } from '@shared/torrentTrackers'
import { useEffect, useState } from 'react'
import { describeError } from '../utils/format'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Textarea } from './ui/textarea'

const SHORTCUT = window.plexo.platform === 'darwin' ? 'Cmd+Enter' : 'Ctrl+Enter'

/**
 * Manages trackers for an active or paused torrent download.
 * Lists the torrent's default trackers and allows adding custom announce URLs.
 */
export function TrackersDialog({
  download,
  onClose
}: {
  download: DownloadState | null
  onClose: () => void
}): React.JSX.Element {
  const [data, setData] = useState<TorrentTrackersResult | null>(null)
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const isOpen = download !== null && download.kind === 'torrent'
  const downloadId = isOpen ? download.id : null
  const loading = data === null && error === null

  const close = (): void => {
    setData(null)
    setInput('')
    setError(null)
    setWarning(null)
    onClose()
  }

  useEffect(() => {
    if (!downloadId) return

    let active = true
    window.plexo
      .torrentTrackers(downloadId)
      .then((result) => {
        if (active) setData(result)
      })
      .catch((failure) => {
        if (active) setError(describeError(failure))
      })

    return () => {
      active = false
    }
  }, [downloadId])

  const handleAdd = async (): Promise<void> => {
    if (!download || !input.trim()) return
    const { valid, invalidCount } = parseTrackerList(input)
    if (valid.length === 0) {
      setError(
        invalidCount > 0
          ? `${invalidCount} ${invalidCount === 1 ? "line wasn't a tracker link" : "lines weren't tracker links"}`
          : 'Please enter at least one valid tracker URL (e.g. udp://... or http://...)'
      )
      setWarning(null)
      return
    }

    setSubmitting(true)
    setError(null)
    setWarning(null)
    try {
      const updated = await window.plexo.addTorrentTrackers(download.id, valid)
      setData(updated)
      setInput('')
      if (invalidCount > 0) {
        setWarning(
          `${invalidCount} ${invalidCount === 1 ? "line wasn't a tracker link" : "lines weren't tracker links"} and was ignored`
        )
      }
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setSubmitting(false)
    }
  }

  const allTrackers = [
    ...(data?.defaultTrackers ?? []).map((url) => ({ url, custom: false })),
    ...(data?.customTrackers ?? []).map((url) => ({ url, custom: true }))
  ]

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && close()} disablePointerDismissal>
      <DialogContent showCloseButton={false} className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Trackers</DialogTitle>
          <DialogDescription>
            {download?.fileName
              ? `Trackers for ${download.fileName}.`
              : 'Manage torrent announce URLs.'}{' '}
            Trackers help discover peers sharing this torrent.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          {data?.isPrivate && (
            <div className="rounded-[7px] border border-amber-500/30 bg-amber-500/10 p-2.5 text-[12px] text-amber-600 dark:text-amber-400">
              This is a private torrent. External trackers cannot be added to private swarms.
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-foreground">
              Active trackers ({loading ? '…' : allTrackers.length})
            </span>
            <div
              tabIndex={0}
              aria-label="Active trackers"
              className="max-h-40 overflow-y-auto rounded-[8px] border border-border bg-card/60 p-2 font-mono text-[11px] select-text"
            >
              {loading ? (
                <div className="text-muted-foreground">Loading trackers…</div>
              ) : allTrackers.length === 0 ? (
                <div className="text-muted-foreground">No announce trackers configured.</div>
              ) : (
                allTrackers.map(({ url, custom }, index) => (
                  <div
                    key={`${url}-${index}`}
                    className="flex items-center justify-between gap-2 py-0.5 border-b border-border/40 last:border-0"
                  >
                    <span className="min-w-0 truncate text-foreground" title={url}>
                      {url}
                    </span>
                    {custom && (
                      <span className="shrink-0 rounded bg-secondary px-1 py-0.5 text-[9.5px] font-sans font-medium text-muted-foreground">
                        Custom
                      </span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {!data?.isPrivate && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void handleAdd()
              }}
            >
              <label className="flex flex-col gap-1.5 text-[12px] font-medium text-foreground">
                <span>Add trackers</span>
                <Textarea
                  autoFocus={!data?.isPrivate}
                  aria-label="New trackers"
                  placeholder={`udp://tracker.opentrackr.org:1337/announce\nhttp://tracker.example.com/announce`}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      void handleAdd()
                    }
                  }}
                  className="min-h-20 font-mono text-[11.5px]"
                  disabled={submitting || data?.isPrivate}
                />
              </label>
              <span className="text-[11px] text-muted-foreground">
                Paste one or more tracker URLs, separated by line breaks ({SHORTCUT} to add).
              </span>
            </form>
          )}

          {warning && (
            <div className="text-[12px] text-amber-600 dark:text-amber-400">{warning}</div>
          )}
          {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}
        </div>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={close}>
            Close
          </Button>
          {!data?.isPrivate && (
            <Button
              type="button"
              disabled={submitting || !input.trim() || data?.isPrivate}
              onClick={() => void handleAdd()}
            >
              {submitting ? 'Adding…' : 'Add trackers'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
