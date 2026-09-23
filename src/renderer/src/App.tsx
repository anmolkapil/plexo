import type { DownloadState } from '@shared/types'
import { useEffect } from 'react'
import { DevToolsPanel } from './components/DevToolsPanel'
import { TitleBar, type TitleBarStatus } from './components/TitleBar'
import { NetworkBindingDialog } from './components/NetworkBindingDialog'
import { UpdateDialog } from './components/UpdateDialog'
import { TooltipProvider } from './components/ui/tooltip'
import { useDownloadEvents } from './hooks/useDownloadEvents'
import { CompleteScreen } from './screens/CompleteScreen'
import { DownloadingScreen } from './screens/DownloadingScreen'
import { ErrorScreen } from './screens/ErrorScreen'
import { IdleScreen } from './screens/IdleScreen'
import { NoConnectionsScreen } from './screens/NoConnectionsScreen'
import { Info, X } from 'lucide-react'
import { useAppStore } from './store/useAppStore'

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
          networkCount: new Set(download.chunks.map((chunk) => chunk.interfaceId)).size
        }
      }
    case 'paused':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: {
          kind: 'paused',
          networkCount: new Set(download.chunks.map((chunk) => chunk.interfaceId)).size
        }
      }
    case 'assembling':
      return {
        screen: <DownloadingScreen download={download} />,
        titleBarStatus: { kind: 'assembling' }
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

  const interfaces = useAppStore((store) => store.interfaces)
  const interfacesStatus = useAppStore((store) => store.interfacesStatus)
  const currentDownload = useAppStore((store) => store.currentDownload)
  const clearCurrentDownload = useAppStore((store) => store.clearCurrentDownload)
  const loadNetworkPreferences = useAppStore((store) => store.loadNetworkPreferences)
  const loadThemeSource = useAppStore((store) => store.loadThemeSource)
  const loadInitialPaths = useAppStore((store) => store.loadInitialPaths)
  const checkForUpdate = useAppStore((store) => store.checkForUpdate)
  const ingestCompanionDownload = useAppStore((store) => store.ingestCompanionDownload)
  const incomingCompanionAlert = useAppStore((store) => store.incomingCompanionAlert)
  const setIncomingCompanionAlert = useAppStore((store) => store.setIncomingCompanionAlert)
  const setDraftHeaders = useAppStore((store) => store.setDraftHeaders)
  const setDraftFileName = useAppStore((store) => store.setDraftFileName)

  useEffect(() => {
    loadNetworkPreferences()
    loadThemeSource()
    loadInitialPaths()
    checkForUpdate()
  }, [loadNetworkPreferences, loadThemeSource, loadInitialPaths, checkForUpdate])

  useEffect(() => {
    return window.plexo.onCompanionDownload((payload) => {
      ingestCompanionDownload(payload)
    })
  }, [ingestCompanionDownload])

  useEffect(() => {
    if (!incomingCompanionAlert) return
    const timer = setTimeout(() => {
      setIncomingCompanionAlert(null)
    }, 8000)
    return () => clearTimeout(timer)
  }, [incomingCompanionAlert, setIncomingCompanionAlert])

  const handleNewDownload = (): void => {
    if (currentDownload) void window.plexo.removeDownload(currentDownload.id)
    clearCurrentDownload()
    setDraftHeaders(undefined)
    setDraftFileName(undefined)
  }

  const handleDownloadAgain = (): void => {
    if (currentDownload) {
      const url = currentDownload.url
      void window.plexo.removeDownload(currentDownload.id)
      clearCurrentDownload()
      setDraftHeaders(undefined)
      setDraftFileName(undefined)
      useAppStore.getState().setDraftUrl(url)
    }
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
        {incomingCompanionAlert && (
          <div className="mx-4 mt-2 flex items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground shadow-sm">
            <div className="flex min-w-0 items-center gap-2">
              <Info className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{incomingCompanionAlert}</span>
            </div>
            <button
              onClick={() => setIncomingCompanionAlert(null)}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-primary/20 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
              title="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="min-h-0 flex-1">{screen}</div>
        <DevToolsPanel />
        <UpdateDialog />
        <NetworkBindingDialog />
      </div>
    </TooltipProvider>
  )
}

export default App
