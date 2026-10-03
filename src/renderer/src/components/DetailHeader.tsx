import type { DownloadState, FinishedDownload } from '@shared/types'
import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from './ui/alert-dialog'
import { Button, buttonVariants } from './ui/button'
import { describeError } from '../utils/format'
import { Checkbox } from './ui/checkbox'

/** The top of a download's own screen, laid out as the list's header is: the way back to the
 * list on the left; Remove… and what the download can do next (`children`, the main action
 * last) on the right. */
export function DetailHeader({
  download,
  children
}: {
  download: DownloadState | FinishedDownload
  children?: React.ReactNode
}): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-border px-5">
      <button
        type="button"
        onClick={() => setView({ name: 'list' })}
        className="-ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 font-sans text-[15px] leading-none font-medium text-[var(--text-secondary)] hover:text-foreground"
      >
        <ChevronLeft className="size-4.5" />
        Downloads
      </button>
      <div className="flex-1" />
      <RemoveButton download={download} />
      {children}
    </div>
  )
}

/** Remove…, asked first. An unfinished download loses what it has; a finished one leaves the
 * list, and its file goes to the Trash only if asked — from where it can still be put back. */
function RemoveButton({
  download
}: {
  download: DownloadState | FinishedDownload
}): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const [trashFile, setTrashFile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const finished = 'unitsWritten' in download || download.status === 'completed'
  const missing = 'missing' in download && download.missing === true
  const trashName = window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'

  return (
    <AlertDialog
      onOpenChange={() => {
        setTrashFile(false)
        setError(null)
      }}
    >
      <AlertDialogTrigger
        render={
          <Button type="button" variant={finished ? 'secondary' : 'destructive'}>
            {finished ? 'Remove from list…' : 'Cancel download…'}
          </Button>
        }
      />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {finished ? 'Remove from list' : 'Cancel download'}: {download.fileName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {finished
              ? 'This removes the download from your list. Its files stay on your computer.'
              : 'This stops the download and deletes its downloaded data.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {finished &&
          !missing &&
          (download.kind !== 'torrent' ||
            !download.folder ||
            !('unitsWritten' in download) ||
            !!download.downloadedFiles?.length) && (
            <label className="flex items-center gap-2.5 text-[13px]">
              <Checkbox checked={trashFile} onCheckedChange={setTrashFile} />
              Also move downloaded files to the {trashName}. Unrelated files stay in place.
            </label>
          )}
        <AlertDialogFooter>
          {error && (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          )}
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({
              variant: finished && !trashFile ? 'default' : 'destructive',
              size: 'sm'
            })}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault()
              setBusy(true)
              void window.plexo
                .removeDownload(download.id, { trashFile })
                .then(() => {
                  useAppStore.setState((store) => {
                    const downloads = { ...store.downloads }
                    delete downloads[download.id]
                    return {
                      downloads,
                      history: store.history.filter((item) => item.id !== download.id)
                    }
                  })
                  setView({ name: 'list' })
                })
                .catch((cause) => setError(describeError(cause)))
                .finally(() => setBusy(false))
            }}
          >
            {trashFile
              ? `Move files to ${trashName}`
              : finished
                ? 'Remove from list'
                : 'Cancel download'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
