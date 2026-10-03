import type { TorrentFileEntry, TorrentPieceState } from '@shared/types'
import { useEffect, useState } from 'react'
import { formatBytes, formatPercent, pathInTorrent } from '../utils/format'

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

/** A torrent download's files, each with how much of it is done; those not chosen dimmed. */
export function TorrentFiles({
  downloadId,
  pieces
}: {
  downloadId: string
  pieces: TorrentPieceState[]
}): React.JSX.Element {
  const [files, setFiles] = useState<TorrentFileEntry[] | null>(null)
  useEffect(() => {
    let stale = false
    void window.plexo.torrentFiles(downloadId).then((entries) => {
      if (!stale) setFiles(entries)
    })
    return () => {
      stale = true
    }
  }, [downloadId])

  const done = files ? verifiedBytes(files, pieces) : []
  return (
    <div
      role="list"
      aria-label="Files"
      className="mt-3 max-h-36 overflow-y-auto rounded-[9px] border border-border px-3 py-1.5"
    >
      {files?.map((file, index) => (
        <div
          role="listitem"
          key={index}
          className={`flex items-center gap-3 py-0.5 font-mono text-[11.5px] ${file.chosen ? '' : 'opacity-45'}`}
        >
          <span className="min-w-0 flex-1 truncate">{pathInTorrent(file.path)}</span>
          <span className="shrink-0 text-muted-foreground">{formatBytes(file.length)}</span>
          <span className="w-14 shrink-0 text-right tabular-nums text-[var(--text-secondary)]">
            {!file.chosen
              ? 'Skipped'
              : `${file.length === 0 ? 100 : formatPercent(done[index], file.length)}%`}
          </span>
        </div>
      ))}
    </div>
  )
}
