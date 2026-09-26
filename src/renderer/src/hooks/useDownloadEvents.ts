import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process download progress pushes for the lifetime of the app. */
export function useDownloadEvents(): void {
  const receiveDownloadUpdate = useAppStore((store) => store.receiveDownloadUpdate)

  useEffect(() => {
    let disposed = false
    // Subscribed before the snapshot is asked for, so nothing sent in between is missed; each
    // update carries a count, so whichever arrives late can't undo the other.
    const unsubscribe = window.plexo.onDownloadUpdated(receiveDownloadUpdate)

    void window.plexo
      .getCurrentDownload()
      .then((snapshot) => {
        if (!disposed && snapshot) receiveDownloadUpdate(snapshot)
      })
      .catch(() => {})

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveDownloadUpdate])
}
