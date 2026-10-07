import { Fragment } from 'react'
import { availableActions, type DownloadItem } from '../utils/downloadActions'
import { useDownloadActions } from './downloadActionsContext'
import { ACTION_META, menuLabel } from './downloadActionMeta'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from './ui/context-menu'

/** Right-click menu for a download row: everything that can be done to it, from the same list
 * as its row button, the toolbar and its own screen. Right-clicking inside the selection acts
 * on everything selected; outside it, on just that row, which is left unselected (selecting
 * would swap the header into the selection toolbar). */
export function DownloadContextMenu({
  item,
  selected,
  chosen,
  children
}: {
  item: DownloadItem
  selected: boolean
  chosen: DownloadItem[]
  children: React.ReactNode
}): React.JSX.Element {
  const { perform } = useDownloadActions()
  const groups = availableActions(selected ? chosen : [item])
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-52">
        {groups.map((group, index) => (
          <Fragment key={group[0].id}>
            {index > 0 && <ContextMenuSeparator />}
            {group.map(({ id, targets }, position) => {
              const meta = ACTION_META[id]
              return (
                <ContextMenuItem
                  key={id}
                  variant={meta.destructive ? 'destructive' : 'default'}
                  // The first is what the row's own button does.
                  className={index === 0 && position === 0 ? 'font-medium' : undefined}
                  onClick={() => void perform(id, targets)}
                >
                  <meta.icon aria-hidden />
                  {menuLabel(id, targets)}
                  {meta.shortcut && <ContextMenuShortcut>{meta.shortcut}</ContextMenuShortcut>}
                </ContextMenuItem>
              )
            })}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}
