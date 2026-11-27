import type { DownloadState } from '@shared/types'
import { useState } from 'react'
import { describeError, formatBytes } from '../utils/format'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog'
import { Input } from './ui/input'

/** Asks for a fresh link to a download whose link stopped working; it carries on from where it
 * stopped (see DownloadManager.relink). Open while `download` is set. */
export function FixLinkDialog({
  download,
  force = false,
  onClose
}: {
  download: DownloadState | null
  force?: boolean
  onClose: () => void
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)

  const close = (): void => {
    setUrl('')
    setError(null)
    onClose()
  }

  const handleFix = async (): Promise<void> => {
    if (!download || !url.trim()) return
    setFixing(true)
    setError(null)
    try {
      await window.plexo.relinkDownload(
        download.id,
        url.trim(),
        force ? { force: true } : undefined
      )
      close()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setFixing(false)
    }
  }

  return (
    <Dialog
      disablePointerDismissal
      open={download !== null}
      onOpenChange={(open) => !open && !fixing && close()}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{force ? 'Refresh link (forced)' : 'Paste a new link'}</DialogTitle>
          <DialogDescription>
            {force
              ? download &&
                `Paste a new link for ${download.fileName}${download.totalBytes > 0 ? ` (${formatBytes(download.totalBytes)})` : ''}. Skips byte-matching against disk, re-downloads the last 4 chunks to guard against corruption, and resumes. Only use this if you are sure it points to the exact same file.`
              : download &&
                `Paste a new link to the same file: ${download.fileName}${download.totalBytes > 0 ? ` (${formatBytes(download.totalBytes)})` : ''}. Plexo resumes from where the download stopped.`}
            {!force &&
              download?.kind === 'http' &&
              download.fromBrowser &&
              ` Or download it again in ${download.fromBrowser} and choose Resume it.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void handleFix()
          }}
        >
          <Input
            autoFocus
            aria-label="New link"
            placeholder="https://…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="font-mono"
          />
          {error && <div className="text-[12px] text-[var(--color-danger)]">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={fixing} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={fixing || !url.trim()}>
              {fixing ? 'Checking' : force ? 'Resume download' : 'Continue download'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
