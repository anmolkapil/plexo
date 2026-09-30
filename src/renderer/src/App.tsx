import type { DownloadState } from '@shared/types'
import { useEffect } from 'react'
import { AddLinksDialog } from './components/AddLinksDialog'
import { TitleBar, type TitleBarStatus } from './components/TitleBar'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { QueueSheet } from './components/QueueSheet'
import { UpdateDialog } from './components/UpdateDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { useQueueEvents } from './hooks/useQueueEvents'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { IdleScreen } from './screens/IdleScreen'
import { NoConnectionsScreen } from './screens/NoConnectionsScreen'
import { queueItemFor, useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen + title-bar status per download.status — a switch with an assertNever default so
 * a new DownloadStatus value is a compile error here instead of silently falling into whichever
 * branch happened to be last. */
function renderDownload(
  download: DownloadState,
  handlers: { onNewDownload: () => void; onDownloadAgain: () => void }
): { screen: React.JSX.Element; titleBarStatus: TitleBarStatus } {
  switch (download.status) {
    case 'downloading':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'combined',
          networkCount: download.networks.filter((network) => network.status === 'on').length
        }
      }
    case 'paused':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'paused',
          networkCount: download.networks.filter((network) => network.enabled).length
        }
      }
    case 'completed':
      return {
        screen: <CompleteScreen download={download} onNewDownload={handlers.onNewDownload} />,
        titleBarStatus: { kind: 'none' }
      }
    case 'error':
    case 'cancelled':
      return {
        screen: (
          <ErrorScreen
            download={download}
            onNewDownload={handlers.onNewDownload}
            onDownloadAgain={handlers.onDownloadAgain}
          />
        ),
        titleBarStatus: { kind: 'none' }
      }
    default:
      return assertNever(download.status)
  }
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useNetworkEvents()
  useQueueEvents()

  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const clearCurrentDownload = useAppStore((store) => store.clearCurrentDownload)
  const checkForUpdate = useAppStore((store) => store.checkForUpdate)

  useEffect(() => {
    checkForUpdate()
  }, [checkForUpdate])

  const handleNewDownload = (): void => {
    const current = currentDownload
    clearCurrentDownload()
    if (!current) return
    // A failed queue item's download holds what it fetched, for the item's Retry to pick up:
    // moving on from its screen leaves it be.
    if (current.status === 'error' && queueItemFor(current.id)) return
    void window.plexo.removeDownload(current.id)
  }

  const handleDownloadAgain = (): void => {
    if (!currentDownload) return
    const { id, url } = currentDownload
    // One of the queue's: it goes back into the queue, into the queue's folder, rather than to
    // the start screen as a download of its own.
    const item = queueItemFor(id)
    clearCurrentDownload()
    if (item) {
      void window.plexo
        .removeDownload(id)
        .then(() => window.plexo.queueCommand({ kind: 'retry', id: item.id }))
        .catch(() => {})
      useAppStore.getState().setQueueOpen(true)
      return
    }
    void window.plexo.removeDownload(id)
    useAppStore.getState().setDraftUrl(url)
  }

  const noConnections = interfacesStatus === 'ready' && interfaces.length === 0

  let screen: React.JSX.Element
  let titleBarStatus: TitleBarStatus = { kind: 'none' }

  if (currentDownload) {
    ;({ screen, titleBarStatus } = renderDownload(currentDownload, {
      onNewDownload: handleNewDownload,
      onDownloadAgain: handleDownloadAgain
    }))
  } else if (noConnections) {
    screen = <NoConnectionsScreen />
    titleBarStatus = { kind: 'offline' }
  } else {
    screen = <IdleScreen />
  }

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TitleBar status={titleBarStatus} />
        <div className="min-h-0 flex-1">{screen}</div>
        <QueueSheet />
        <AddLinksDialog />
        <UpdateDialog />
        <NetworkBindingDialog />
      </div>
    </TooltipProvider>
  )
}

export default App
