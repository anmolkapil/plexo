import type { DownloadState, FinishedDownload } from '@shared/types'
import { DownloadActionsProvider } from './components/DownloadActionsProvider'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { NewDownloadDialog } from './components/NewDownloadDialog'
import { StatusBar } from './components/StatusBar'
import { TelegramDialog } from './components/TelegramDialog'
import { TitleBar } from './components/TitleBar'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { useNetworkEvents } from './hooks/useNetworks'
import { useNewDownloadShortcuts, useOpenedLinks } from './hooks/useOpenedLinks'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { DownloadsScreen } from './screens/DownloadsScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { useAppStore } from './store/useAppStore'

function assertNever(status: never): never {
  throw new Error(`Unhandled download status: ${String(status)}`)
}

/** One screen per download.status — a switch with an assertNever default so a new
 * DownloadStatus value is a compile error here instead of silently falling into whichever branch
 * happened to be last. */
function renderDownload(download: DownloadState | FinishedDownload): React.JSX.Element {
  if ('unitsWritten' in download) return <CompleteScreen download={download} />
  switch (download.status) {
    case 'queued':
    case 'downloading':
    case 'paused':
      return <DownloadingScreen download={download} />
    case 'completed':
      return <CompleteScreen download={download} />
    case 'error':
    case 'cancelled':
      return <ErrorScreen download={download} />
    default:
      return assertNever(download.status)
  }
}

/** The download shown, or the list. Only this re-renders on a progress update — App, the title
 * bar, the status bar and the dialogs around it don't. */
function CurrentScreen(): React.JSX.Element {
  // Just the one shown: an update to any other download leaves this selector's result alone.
  const shown = useAppStore((store) => {
    const { view } = store
    if (view.name !== 'download') return null
    // A download that's gone (removed, deleted) leaves the list showing.
    return store.downloads[view.id] ?? store.history.find((entry) => entry.id === view.id) ?? null
  })
  const cancelled = shown && !('unitsWritten' in shown) && shown.status === 'cancelled'
  return shown && !cancelled ? renderDownload(shown) : <DownloadsScreen />
}

function App(): React.JSX.Element {
  useDownloadEvents()
  useOpenedLinks()
  useNewDownloadShortcuts()
  useNetworkEvents()

  return (
    <TooltipProvider>
      <DownloadActionsProvider>
        <div className="flex h-full flex-col">
          <TitleBar />
          <div className="min-h-0 flex-1">
            <CurrentScreen />
          </div>
          <StatusBar />
          <NewDownloadDialog />
          <TelegramDialog />
          <NetworkBindingDialog />
        </div>
      </DownloadActionsProvider>
    </TooltipProvider>
  )
}

export default App
