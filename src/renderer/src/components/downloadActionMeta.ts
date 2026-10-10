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

const SOMETHING_WRONG = 'Something went wrong'

interface ActionMeta {
  /** For one download: menus and a download's own screen. */
  label: string
  /** For several, in a menu. */
  many?: (count: number) => string
  /** On the selection toolbar's own button, before the count. */
  toolbar?: string
  /** For one download only: its toolbar button has no count. */
  single?: boolean
  /** What its button says while it works. */
  working?: string
  /** The title of the dialog that says it didn't work. */
  failure: string
  icon: LucideIcon
  destructive?: boolean
}

export const ACTION_META: Record<ActionId, ActionMeta> = {
  pause: {
    label: 'Pause',
    many: (n) => `Pause ${n} downloads`,
    toolbar: 'Pause',
    working: 'Pausing',
    failure: 'Couldn’t pause',
    icon: Pause
  },
  resume: {
    label: 'Resume',
    many: (n) => `Resume ${n} downloads`,
    toolbar: 'Resume',
    working: 'Resuming',
    failure: 'Couldn’t resume',
    icon: Play
  },
  retry: {
    label: 'Retry',
    many: (n) => `Retry ${n} downloads`,
    toolbar: 'Retry',
    working: 'Retrying',
    failure: 'Couldn’t retry',
    icon: RotateCw
  },
  fix: {
    label: 'Fix link',
    toolbar: 'Fix link',
    single: true,
    failure: SOMETHING_WRONG,
    icon: Wrench
  },
  again: {
    label: 'Download again',
    toolbar: 'Download again',
    single: true,
    failure: 'Couldn’t start again',
    icon: Download
  },
  open: {
    label: 'Open',
    toolbar: 'Open',
    single: true,
    failure: 'Couldn’t open file',
    icon: ExternalLink
  },
  reveal: {
    label: REVEAL_LABEL,
    toolbar: REVEAL_LABEL,
    single: true,
    failure: 'Couldn’t show file',
    icon: FolderOpen
  },
  copy: {
    label: 'Copy link',
    many: (n) => `Copy ${n} links`,
    failure: 'Couldn’t copy link',
    icon: Copy
  },
  cancel: {
    label: 'Cancel download',
    many: (n) => `Cancel ${n} downloads`,
    toolbar: 'Cancel downloads',
    failure: SOMETHING_WRONG,
    icon: X,
    destructive: true
  },
  remove: {
    label: 'Remove from list',
    many: (n) => `Remove ${n} from list`,
    toolbar: 'Remove from list',
    failure: SOMETHING_WRONG,
    icon: ListX
  },
  trash: {
    label: `Move file to ${TRASH_NAME}`,
    many: (n) => `Move ${n} files to ${TRASH_NAME}`,
    toolbar: `Move to ${TRASH_NAME}`,
    failure: SOMETHING_WRONG,
    icon: Trash2,
    destructive: true
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
  const meta = ACTION_META[id]
  const name = meta.toolbar ?? meta.label
  return meta.single ? name : `${name} (${count})`
}
