import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

export function useQueueProcessor(): void {
  const currentDownload = useAppStore((store) => store.currentDownload)
  const queuedUrls = useAppStore((store) => store.queuedUrls)
  const isProcessing = useRef(false)

  useEffect(() => {
    if (isProcessing.current) return

    const isIdle = !currentDownload
    const isFinished =
      currentDownload?.status === 'completed' ||
      currentDownload?.status === 'error' ||
      currentDownload?.status === 'cancelled'

    if ((isIdle || isFinished) && queuedUrls.length > 0) {
      isProcessing.current = true

      const processNext = async (): Promise<void> => {
        const item = useAppStore.getState().popQueuedUrl()
        if (!item) {
          isProcessing.current = false
          return
        }

        try {
          const result = await window.plexo.probeUrl(item.url)
          const destinationDir = useAppStore.getState().destinationDir
          const interfaceIds = useAppStore.getState().interfaces.map((i) => i.id)
          const multiChunkAllowed = result.supportsRanges && result.totalBytes !== null

          if (isFinished && currentDownload) {
            await window.plexo.removeDownload(currentDownload.id)
            useAppStore.getState().clearCurrentDownload()
          }

          await window.plexo.startDownload({
            url: result.finalUrl,
            destinationDir,
            suggestedFileName: result.suggestedFileName,
            totalBytes: result.totalBytes ?? 0,
            supportsRanges: multiChunkAllowed,
            interfaceIds: multiChunkAllowed ? interfaceIds : interfaceIds.slice(0, 1),
            etag: result.etag,
            lastModified: result.lastModified,
            streamsPerNetwork: item.streamsPerNetwork
          })

          isProcessing.current = false
        } catch (err) {
          console.error('Failed to process queued URL:', item.url, err)
          // Try the next one
          processNext()
        }
      }

      processNext()
    }
  }, [currentDownload, currentDownload?.status, currentDownload?.id, queuedUrls.length])
}
