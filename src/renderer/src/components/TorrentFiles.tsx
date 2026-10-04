import type { TorrentFileEntry, TorrentInfo, TorrentPieceState } from '@shared/types'
import { cn } from 'cn'
import { Folder } from 'lucide-react'
import { useEffect, useState } from 'react'
import { describeError, formatBytes, formatPercent, pathInTorrent } from '../utils/format'
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

/** A torrent's files, each ticked to be downloaded. Several come in the torrent's folder, whose
 * row above them, by its name, ticks all of them. Given `done` (each file's bytes in), each shows
 * how far it is, and one all in stays ticked: it's downloaded. */
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
  // A torrent in a folder (always so with several files) starts every path with it.
  const parts = files[0]?.path.split(/[\\/]/) ?? []
  const folder = parts.length > 1 ? parts[0] : null
  const finished = (index: number): boolean =>
    done !== undefined && done[index] >= files[index].length
  return (
    <div
      role="group"
      aria-label="Files"
      className="max-h-44 overflow-y-auto rounded-[9px] border border-border px-3 py-1.5"
    >
      {folder && (
        <label className="flex items-center gap-2 py-0.5 font-mono text-[11.5px] font-medium">
          <Checkbox
            checked={skipped.length === 0}
            indeterminate={skipped.length > 0 && skipped.length < files.length}
            onCheckedChange={(checked) =>
              // Unticking all leaves the downloaded ones: they're in.
              onChange(checked ? [] : files.flatMap((_, index) => (finished(index) ? [] : [index])))
            }
          />
          <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{folder}</span>
        </label>
      )}
      {files.map((file, index) => (
        <label
          key={index}
          className={cn('flex items-center gap-2 py-0.5 font-mono text-[11.5px]', folder && 'pl-6')}
        >
          <Checkbox
            checked={!skipped.includes(index)}
            disabled={finished(index)}
            onCheckedChange={(checked) =>
              onChange(checked ? skipped.filter((entry) => entry !== index) : [...skipped, index])
            }
          />
          <span className="min-w-0 flex-1 truncate">{pathInTorrent(file.path)}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.length)}</span>
          {done && (
            <span className="w-14 shrink-0 text-right tabular-nums text-[var(--text-secondary)]">
              {skipped.includes(index)
                ? 'Skipped'
                : finished(index)
                  ? 'Done'
                  : `${formatPercent(done[index], file.length)}%`}
            </span>
          )}
        </label>
      ))}
    </div>
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
