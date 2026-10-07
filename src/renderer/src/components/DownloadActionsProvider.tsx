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
    async (id: ActionId, targets: DownloadItem[]): Promise<boolean> => {
      setError(null)
      const fail = (cause: unknown): false => {
        setError(describeError(cause))
        return false
      }
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
          return failed ? fail(failed.reason) : true
        }
        case 'fix':
          setFixing(targets[0] as DownloadState)
          return true
        case 'again': {
          // Nothing of it can be kept: it goes, and its link waits in New download to start over.
          // Only once it's really gone, so the new one can't collide with what's left of it.
          const [item] = targets
          try {
            await window.plexo.removeDownload(item.id)
          } catch (cause) {
            return fail(cause)
          }
          useAppStore.getState().forgetDownload(item.id)
          setView({ name: 'list' })
          openNewDownload(item.url)
          return true
        }
        case 'open':
        case 'reveal': {
          try {
            const [item] = targets
            const found =
              id === 'open'
                ? await window.plexo.openDownload(item.id)
                : await window.plexo.revealDownload(item.id)
            return found || fail('That file is no longer where it was saved.')
          } catch (cause) {
            return fail(cause)
          }
        }
        case 'copy':
          return navigator.clipboard
            .writeText(targets.map((item) => item.url).join('\n'))
            .then(() => true)
            .catch(fail)
        case 'cancel':
        case 'remove':
        case 'trash':
          setDialogError(null)
          setConfirmation({
            mode: id === 'cancel' ? 'cancel' : id === 'trash' ? 'trash' : 'remove',
            items: targets,
            clearAll: false
          })
          return true
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
    const { mode, items, clearAll } = confirmation
    setBusy(true)
    setDialogError(null)
    try {
      // One failing doesn't hold back the rest: each that goes is dropped from the window and
      // from the question, so what's left asked about is exactly what still needs doing.
      const gone = new Set<string>()
      let firstFailure: unknown
      if (clearAll) {
        await window.plexo.clearHistory()
      } else {
        for (const item of items) {
          try {
            await window.plexo.removeDownload(item.id, { trashFile: mode === 'trash' })
            useAppStore.getState().forgetDownload(item.id)
            gone.add(item.id)
          } catch (cause) {
            firstFailure ??= cause
          }
        }
      }
      // Showing one that's gone: back to the list.
      const view = useAppStore.getState().view
      if (view.name === 'download' && (clearAll || gone.has(view.id))) setView({ name: 'list' })
      const left = items.filter((item) => !gone.has(item.id))
      if (!clearAll && left.length > 0) {
        setConfirmation({ mode, items: left, clearAll })
        setDialogError(
          `${left.length} of ${items.length} couldn’t be removed: ${describeError(firstFailure)}`
        )
      } else setConfirmation(null)
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
