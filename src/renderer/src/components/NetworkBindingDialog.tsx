import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './ui/alert-dialog'

/** Only warn once there's a second network that won't get used. */
export function NetworkBindingDialog(): React.JSX.Element {
  const networkCount = useAppStore((store) => store.interfaces.length)
  const [supported, setSupported] = useState(true)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.plexo.deviceBindingSupported().then(setSupported, () => {})
  }, [])

  return (
    <AlertDialog
      open={!supported && !dismissed && networkCount > 1}
      onOpenChange={(open) => {
        if (!open) setDismissed(true)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Only your default network can be used</AlertDialogTitle>
          <AlertDialogDescription>
            Plexo couldn&apos;t bind connections to individual networks. Downloads will use your
            system&apos;s routing instead, so the other networks may not add speed.
            {window.plexo.platform === 'linux' && ' On Linux, this requires kernel 5.7 or newer.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
