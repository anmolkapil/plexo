import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'

/** Says what went wrong with something the user just asked for — a file that's moved, a download
 * that wouldn't start — in the same kind of dialog the app asks its questions in, wherever the
 * action came from. Open while `failure` is set. */
export function ActionErrorDialog({
  failure,
  onClose
}: {
  failure: { title: string; message: string } | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <AlertDialog open={failure !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{failure?.title}</AlertDialogTitle>
          <AlertDialogDescription>{failure?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
