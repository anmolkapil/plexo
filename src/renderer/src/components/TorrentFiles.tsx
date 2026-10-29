import type { TorrentFileEntry, TorrentInfo, TorrentPieceState } from '@shared/types'
import { Folder, FolderOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { describeError, formatBytes, formatPercent } from '../utils/format'
import {
  applyChoice,
  buildTree,
  folderState,
  visibleRows,
  type DirNode,
  type FileNode
} from '../utils/torrentTree'
import { Checkbox } from './ui/checkbox'

/** Bytes of each file that are in verified pieces. Files and pieces both run in byte order, so
 * one pass over each. */
function verifiedBytes(files: TorrentFileEntry[], pieces: TorrentPieceState[]): number[] {
  // Exclusive. A piece's rangeEnd is never null: that's for HTTP downloads of unknown size.
  const endOf = (piece: TorrentPieceState): number => (piece.rangeEnd ?? piece.rangeStart) + 1
  let start = 0
  let first = 0
  return files.map((file) => {
    const end = start + file.length
    while (first < pieces.length && endOf(pieces[first]) <= start) first++
    let done = 0
    for (let at = first; at < pieces.length && pieces[at].rangeStart < end; at++) {
      const piece = pieces[at]
      if (piece.status === 'completed') {
        done += Math.min(end, endOf(piece)) - Math.max(start, piece.rangeStart)
      }
    }
    start = end
    return done
  })
}

/** A torrent's files, each ticked to be downloaded. Shown as the torrent's folder tree, so a whole
 * folder can be ticked at once, with All and None for the lot. Given `done` (each file's bytes in),
 * each file shows how far it is, and one all in stays ticked: it's downloaded. */
export function TorrentFileList({
  files,
  skipped,
  onChange,
  done
}: {
  files: TorrentInfo['files']
  skipped: number[]
  onChange: (skipped: number[]) => void
  done?: number[]
}): React.JSX.Element {
  // Folders left rather than folders open: a torrent starts with all of them open, as the flat
  // list had them, and a collapse is remembered.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const tree = useMemo(() => buildTree(files), [files])
  const skippedSet = useMemo(() => new Set(skipped), [skipped])

  const isFinished = (index: number): boolean =>
    done !== undefined && done[index] >= files[index].length
  const isChosen = (index: number): boolean => !skippedSet.has(index)

  const toggleFolder = (path: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** Tick or untick every not-yet-downloaded file in `indices`; downloaded ones are left chosen. */
  const choose = (indices: readonly number[], checked: boolean): void =>
    onChange(applyChoice(skippedSet, indices, checked, isFinished))

  const selectAll = (): void => onChange([])
  /** Nothing ticked but what's already in: skipping a download's finished files is meaningless. */
  const selectNone = (): void =>
    onChange(files.flatMap((_, index) => (isFinished(index) ? [] : [index])))

  const rows = useMemo(() => visibleRows(tree, collapsed), [tree, collapsed])
  const chosenCount = files.reduce((sum, _, index) => sum + (isChosen(index) ? 1 : 0), 0)
  // Something left that None could still turn off.
  const noneAvailable = files.some((_, index) => isChosen(index) && !isFinished(index))

  return (
    <div
      role="group"
      aria-label="Files"
      className="max-h-44 overflow-y-auto rounded-[9px] border border-border px-2 py-1.5"
    >
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
          {chosenCount} of {files.length} {files.length === 1 ? 'file' : 'files'} chosen
        </span>
        <button
          type="button"
          onClick={selectAll}
          disabled={chosenCount === files.length}
          className={toolbarButton}
        >
          All
        </button>
        <button
          type="button"
          onClick={selectNone}
          disabled={!noneAvailable}
          className={toolbarButton}
        >
          None
        </button>
      </div>
      {rows.map((node) =>
        node.kind === 'dir' ? (
          <FolderRow
            key={`d:${node.path}`}
            node={node}
            collapsed={collapsed.has(node.path)}
            state={folderState(node, isFinished, isChosen)}
            disabled={node.fileIndices.every(isFinished)}
            onToggle={() => toggleFolder(node.path)}
            onChoose={(checked) => choose(node.fileIndices, checked)}
          />
        ) : (
          <FileRow
            key={`f:${node.index}`}
            node={node}
            chosen={isChosen(node.index)}
            finished={isFinished(node.index)}
            done={done?.[node.index]}
            onChoose={(checked) => choose([node.index], checked)}
          />
        )
      )}
    </div>
  )
}

/** Padding that steps in one folder per level, with room for the caret at the top. */
const indent = (depth: number): string => `${4 + depth * 14}px`

/** The look of the All/None buttons, sized to sit on the file list's header. */
const toolbarButton =
  'rounded px-1.5 py-0.5 font-mono text-[10px] tracking-[0.08em] text-[var(--text-secondary)] uppercase hover:bg-secondary hover:text-foreground disabled:opacity-40'

function FolderRow({
  node,
  collapsed,
  state,
  disabled,
  onToggle,
  onChoose
}: {
  node: DirNode
  collapsed: boolean
  state: { checked: boolean; indeterminate: boolean }
  disabled: boolean
  onToggle: () => void
  onChoose: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: indent(node.depth) }}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.name}`}
        aria-expanded={!collapsed}
        className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {collapsed ? (
          <Folder aria-hidden className="size-3.5" />
        ) : (
          <FolderOpen aria-hidden className="size-3.5" />
        )}
      </button>
      <Checkbox
        checked={state.checked}
        indeterminate={state.indeterminate}
        disabled={disabled}
        onCheckedChange={(checked) => onChoose(Boolean(checked))}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium">
        {node.name}
      </span>
    </div>
  )
}

function FileRow({
  node,
  chosen,
  finished,
  done,
  onChoose
}: {
  node: FileNode
  chosen: boolean
  finished: boolean
  done: number | undefined
  onChoose: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: indent(node.depth) }}>
      <span aria-hidden className="size-4 shrink-0" />
      <Checkbox
        checked={chosen}
        disabled={finished}
        onCheckedChange={(checked) => onChoose(Boolean(checked))}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{node.name}</span>
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
        {formatBytes(node.length)}
      </span>
      {done !== undefined && (
        <span className="w-14 shrink-0 text-right font-mono text-[11.5px] tabular-nums text-[var(--text-secondary)]">
          {!chosen ? 'Skipped' : finished ? 'Done' : `${formatPercent(done, node.length)}%`}
        </span>
      )}
    </label>
  )
}

/** A torrent download's files once it has started: how far each is, and which to fetch, changed
 * as it runs. The choice is main's, `selected` as its state has it (unset: every file): a change
 * is asked for, and shows once the state it's sent back has it. */
export function TorrentFiles({
  downloadId,
  pieces,
  selected
}: {
  downloadId: string
  pieces: TorrentPieceState[]
  selected: number[] | undefined
}): React.JSX.Element | null {
  const [files, setFiles] = useState<TorrentFileEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stale = false
    void window.plexo.torrentFiles(downloadId).then((entries) => {
      if (!stale) setFiles(entries)
    })
    return () => {
      stale = true
    }
  }, [downloadId])

  if (!files) return null
  const skipped = selected
    ? files.flatMap((_, index) => (selected.includes(index) ? [] : [index]))
    : []
  const choose = (next: number[]): void => {
    if (next.length === files.length) {
      setError('Keep at least one file.')
      return
    }
    setError(null)
    const chosen = files.flatMap((_, index) => (next.includes(index) ? [] : [index]))
    window.plexo
      .chooseTorrentFiles(downloadId, chosen)
      .catch((cause) => setError(describeError(cause)))
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <TorrentFileList
        files={files}
        skipped={skipped}
        onChange={choose}
        done={verifiedBytes(files, pieces)}
      />
      {error && (
        <p role="alert" className="text-[12px] text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  )
}
