import { useRef } from 'react'
import { DownloadIcon } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'
import { buttonVariants } from './ui/button'

export function UpdateDialog(): React.JSX.Element | null {
  const availableUpdate = useAppStore((store) => store.availableUpdate)
  const dismissUpdate = useAppStore((store) => store.dismissUpdate)
  const downloadRef = useRef<HTMLAnchorElement>(null)

  if (!availableUpdate) return null

  return (
    <AlertDialog
      open={!availableUpdate.dismissed}
      onOpenChange={(open) => {
        if (!open) dismissUpdate()
      }}
    >
      {/* Focus Download, not the first button (Not now), so the primary action is the default. */}
      <AlertDialogContent initialFocus={downloadRef}>
        <AlertDialogHeader>
          <AlertDialogTitle>Plexo {availableUpdate.version} is available</AlertDialogTitle>
          <AlertDialogDescription>A new version is ready to download.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          {/* target="_blank" routes through the main process's window-open handler, which hands
           * http(s) links to the OS browser instead of opening a second app window. */}
          <AlertDialogAction
            className={buttonVariants({ size: 'sm' })}
            render={
              <a ref={downloadRef} href={availableUpdate.url} target="_blank" rel="noreferrer" />
            }
          >
            <DownloadIcon /> Download
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
