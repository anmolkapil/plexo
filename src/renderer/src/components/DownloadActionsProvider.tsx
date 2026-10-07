import type { DownloadState } from '@shared/types'
import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import type { ActionId, DownloadItem } from '../utils/downloadActions'
import { ActionsContext, StateContext } from './downloadActionsContext'
import { FixLinkDialog } from './FixLinkDialog'
import { RemoveDialog, type RemoveMode } from './RemoveDialog'

/** What can be done to a download, done: from its row, its menu, the selection toolbar and its
 * own screen alike. It owns the two questions an action can lead to (fix the link, confirm a
 * removal), so they look and behave the same wherever they're asked from. */
export function DownloadActionsProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const setView = useAppStore((store) => store.setView)
  const openNewDownload = useAppStore((store) => store.openNewDownload)
  const [confirmation, setConfirmation] = useState<{
    mode: RemoveMode
    items: DownloadItem[]
    clearAll: boolean
  } | null>(null)
  const [fixing, setFixing] = useState<DownloadState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)

  const perform = useCallback(
    async (id: ActionId, targets: DownloadItem[]): Promise<void> => {
      setError(null)
      switch (id) {
        case 'pause':
        case 'resume':
        case 'retry': {
          const results = await Promise.allSettled(
            targets.map((item) =>
              id === 'pause'
                ? window.plexo.pauseDownload(item.id)
                : window.plexo.resumeDownload(item.id)
            )
          )
          const failed = results.find((result) => result.status === 'rejected')
          if (failed) setError(describeError(failed.reason))
          return
        }
        case 'fix':
          setFixing(targets[0] as DownloadState)
          return
        case 'again': {
          // Nothing of it can be kept: it goes, and its link waits in New download to start over.
          const [item] = targets
          useAppStore.getState().removeDownload(item.id)
          setView({ name: 'list' })
          openNewDownload(item.url)
          return
        }
        case 'open':
          await window.plexo.openDownload(targets[0].id)
          return
        case 'reveal':
          await window.plexo.revealDownload(targets[0].id)
          return
        case 'copy':
          await navigator.clipboard
            .writeText(targets.map((item) => item.url).join('\n'))
            .catch(() => {})
          return
        case 'cancel':
        case 'remove':
        case 'trash':
          setDialogError(null)
          setConfirmation({
            mode: id === 'cancel' ? 'cancel' : id === 'trash' ? 'trash' : 'remove',
            items: targets,
            clearAll: false
          })
      }
    },
    [setView, openNewDownload]
  )

  const askClearFinished = useCallback((): void => {
    setDialogError(null)
    setConfirmation({ mode: 'remove', items: useAppStore.getState().history, clearAll: true })
  }, [])

  const confirmRemoval = async (): Promise<void> => {
    if (!confirmation || busy) return
    setBusy(true)
    setDialogError(null)
    try {
      if (confirmation.clearAll) await window.plexo.clearHistory()
      else {
        for (const item of confirmation.items) {
          await window.plexo.removeDownload(item.id, { trashFile: confirmation.mode === 'trash' })
          useAppStore.setState((store) => {
            const { [item.id]: removed, ...downloads } = store.downloads
            void removed
            return { downloads, history: store.history.filter((entry) => entry.id !== item.id) }
          })
        }
      }
      // Showing one that's gone: back to the list.
      const view = useAppStore.getState().view
      if (
        view.name === 'download' &&
        (confirmation.clearAll || confirmation.items.some((item) => item.id === view.id))
      )
        setView({ name: 'list' })
      setConfirmation(null)
    } catch (cause) {
      setDialogError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const actions = useMemo(() => ({ perform, askClearFinished }), [perform, askClearFinished])
  const state = useMemo(() => ({ busy, error }), [busy, error])

  return (
    <ActionsContext.Provider value={actions}>
      <StateContext.Provider value={state}>
        {children}
        <RemoveDialog
          open={confirmation !== null}
          onOpenChange={(open) => !open && !busy && setConfirmation(null)}
          mode={confirmation?.mode ?? 'remove'}
          items={confirmation?.items ?? []}
          clearAll={confirmation?.clearAll}
          busy={busy}
          error={dialogError}
          onConfirm={() => void confirmRemoval()}
        />
        <FixLinkDialog download={fixing} onClose={() => setFixing(null)} />
      </StateContext.Provider>
    </ActionsContext.Provider>
  )
}
