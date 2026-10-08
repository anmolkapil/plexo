import { createContext, useContext } from 'react'
import type { ActionId, DownloadItem } from '../utils/downloadActions'

export interface Actions {
  /** Does `id` to `targets`, or asks first where it deletes something. Resolves once it's been
   * sent (a question that's asked resolves at once): true if it went through, false if it failed
   * (a dialog says why). */
  perform: (id: ActionId, targets: DownloadItem[]) => Promise<boolean>
  /** Asks to clear the whole finished list. */
  askClearFinished: () => void
}

export interface ActionsState {
  /** A removal is under way. */
  busy: boolean
}

export const ActionsContext = createContext<Actions | null>(null)
export const StateContext = createContext<ActionsState>({ busy: false })

/** The actions, which never change: safe to pass to memoized rows. */
export function useDownloadActions(): Actions {
  const actions = useContext(ActionsContext)
  if (!actions) throw new Error('useDownloadActions needs a DownloadActionsProvider')
  return actions
}

/** Whether a removal is under way. Changes as it does. */
export function useDownloadActionsState(): ActionsState {
  return useContext(StateContext)
}
