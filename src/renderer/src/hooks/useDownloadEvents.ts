import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to main-process download pushes for the lifetime of the app. */
export function useDownloadEvents(): void {
  const receiveDownloadUpdate = useAppStore((store) => store.receiveDownloadUpdate)
  const receiveHistory = useAppStore((store) => store.receiveHistory)

  useEffect(() => {
    let disposed = false
    const loadHistory = (): void => {
      void window.plexo
        .listHistory()
        .then((history) => {
          if (!disposed) receiveHistory(history)
        })
        .catch(() => {})
    }
    // Subscribed before the snapshots are asked for, so nothing sent in between is missed; each
    // update carries a count, so whichever arrives late can't undo the other.
    const unsubscribe = window.plexo.onDownloadUpdated(receiveDownloadUpdate)
    // A bulk removal changes history once per download: list it once they've settled, rather
    // than re-checking every entry's file after each one. The rows already went from the store.
    let reload: ReturnType<typeof setTimeout> | undefined
    const unsubscribeHistory = window.plexo.onHistoryChanged(() => {
      clearTimeout(reload)
      reload = setTimeout(loadHistory, 150)
    })
    // A finished file can only be moved or deleted while Plexo is in the background: listing
    // again on coming back keeps "moved or deleted" true to the disk, as browsers do when their
    // downloads list is opened.
    window.addEventListener('focus', loadHistory)

    void window.plexo
      .listDownloads()
      .then((snapshots) => {
        if (!disposed) for (const snapshot of snapshots) receiveDownloadUpdate(snapshot)
      })
      .catch(() => {})
    loadHistory()

    return () => {
      disposed = true
      clearTimeout(reload)
      window.removeEventListener('focus', loadHistory)
      unsubscribe()
      unsubscribeHistory()
    }
  }, [receiveDownloadUpdate, receiveHistory])
}
