import { createContext, useContext } from 'react'
import type { ActionId, DownloadItem } from '../utils/downloadActions'

export interface Actions {
  /** Does `id` to `targets`, or asks first where it deletes something. Resolves once it's been
   * sent (a question that's asked resolves at once). */
  perform: (id: ActionId, targets: DownloadItem[]) => Promise<void>
  /** Asks to clear the whole finished list. */
  askClearFinished: () => void
}

export interface ActionsState {
  /** A removal is under way. */
  busy: boolean
  /** The last thing that failed, to show beside the list. */
  error: string | null
}

export const ActionsContext = createContext<Actions | null>(null)
export const StateContext = createContext<ActionsState>({ busy: false, error: null })

/** The actions, which never change: safe to pass to memoized rows. */
export function useDownloadActions(): Actions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useDownloadActions needs a DownloadActionsProvider')
  return actions
}

/** Whether a removal is under way, and the last failure. Changes as they do. */
export function useDownloadActionsState(): ActionsState {
  return useContext(StateContext)
}
