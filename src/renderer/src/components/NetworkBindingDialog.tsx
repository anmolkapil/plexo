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

/** Linux before 5.7 can't pin a connection to one network, so everything leaves through the
 * default route — only worth saying once there's a second network that won't get used. */
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
            This system doesn&apos;t let apps send a connection through a specific network, which
            needs Linux kernel 5.7 or newer. Every connection will go through your default network,
            so the others will show no ping and won&apos;t add speed. Updating your system fixes
            this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
