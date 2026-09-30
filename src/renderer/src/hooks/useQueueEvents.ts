import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Subscribes once to the main process's queue for the lifetime of the app. */
export function useQueueEvents(): void {
  const receiveQueue = useAppStore((store) => store.receiveQueue)

  useEffect(() => {
    let disposed = false
    let received = false
    // Subscribed before asking, so nothing sent in between is missed; a push that lands first is
    // newer than the answer, which is then dropped.
    const unsubscribe = window.plexo.onQueueUpdated((queue) => {
      received = true
      receiveQueue(queue)
    })
    void window.plexo
      .getQueue()
      .then((queue) => {
        if (!disposed && !received) receiveQueue(queue)
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [receiveQueue])
}
