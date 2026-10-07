import {
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  ListX,
  Pause,
  Play,
  RotateCw,
  Trash2,
  Wrench,
  X,
  type LucideIcon
} from 'lucide-react'
import type { ActionId, DownloadItem } from '../utils/downloadActions'

const MAC = window.plexo.platform === 'darwin'
export const TRASH_NAME = window.plexo.platform === 'win32' ? 'Recycle Bin' : 'Trash'
const REVEAL_LABEL = MAC ? 'Show in Finder' : 'Show in folder'

interface ActionMeta {
  /** For one download: menus and a download's own screen. */
  label: string
  /** For several, in a menu. */
  many?: (count: number) => string
  /** For the selection toolbar, before the count; absent: not a toolbar action. */
  toolbar?: string
  /** What its button says while it works. */
  working?: string
  icon: LucideIcon
  destructive?: boolean
  /** The key that does it with a selection. */
  shortcut?: string
}

export const ACTION_META: Record<ActionId, ActionMeta> = {
  pause: {
    label: 'Pause',
    many: (n) => `Pause ${n} downloads`,
    toolbar: 'Pause',
    working: 'Pausing',
    icon: Pause
  },
  resume: {
    label: 'Resume',
    many: (n) => `Resume ${n} downloads`,
    toolbar: 'Resume',
    working: 'Resuming',
    icon: Play
  },
  retry: {
    label: 'Retry',
    many: (n) => `Retry ${n} downloads`,
    toolbar: 'Retry',
    working: 'Retrying',
    icon: RotateCw
  },
  fix: { label: 'Fix link', icon: Wrench },
  again: { label: 'Download again', icon: Download },
  open: { label: 'Open', icon: ExternalLink },
  reveal: { label: REVEAL_LABEL, icon: FolderOpen },
  copy: { label: 'Copy link', many: (n) => `Copy ${n} links`, icon: Copy },
  cancel: {
    label: 'Cancel download',
    many: (n) => `Cancel ${n} downloads`,
    toolbar: 'Cancel downloads',
    icon: X,
    destructive: true
  },
  remove: {
    label: 'Remove from list',
    many: (n) => `Remove ${n} from list`,
    toolbar: 'Remove from list',
    icon: ListX,
    shortcut: MAC ? '⌫' : 'Del'
  },
  trash: {
    label: `Move file to ${TRASH_NAME}`,
    many: (n) => `Move ${n} files to ${TRASH_NAME}`,
    toolbar: `Move files to ${TRASH_NAME}`,
    icon: Trash2,
    destructive: true,
    shortcut: MAC ? '⌘⌫' : 'Ctrl+Del'
  }
}

/** The name in a menu: spelled out for several ("Pause 3 downloads"). */
export function menuLabel(id: ActionId, items: DownloadItem[]): string {
  const meta = ACTION_META[id]
  if (id === 'copy' && items.every((item) => item.url.startsWith('magnet:')))
    return items.length > 1 ? `Copy ${items.length} magnet links` : 'Copy magnet link'
  return items.length > 1 && meta.many ? meta.many(items.length) : meta.label
}

/** The name on a toolbar button: with the count, however many ("Pause (1)"). */
export function toolbarLabel(id: ActionId, count: number): string {
  return `${ACTION_META[id].toolbar ?? ACTION_META[id].label} (${count})`
}
