// Choosing which of a torrent's files to download. Pure.

/**
 * The files to download, from what the window asked for: null for all of them. Indexes that don't
 * name a file, or none at all, are refused.
 */
export function chosenFiles(
  requested: readonly number[] | undefined,
  count: number
): Set<number> | null {
  if (requested === undefined) return null
  const chosen = new Set(requested)
  if ([...chosen].some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new Error('A file chosen for this torrent isn’t in it')
  }
  if (chosen.size === 0) throw new Error('Choose at least one file to download')
  return chosen.size === count ? null : chosen
}

/** The first and last piece each file has bytes in; null for an empty file, which has none. */
function fileSpans(
  files: readonly { length: number }[],
  pieceLength: number
): ([number, number] | null)[] {
  let offset = 0
  return files.map((file) => {
    const span: [number, number] | null =
      file.length > 0
        ? [Math.floor(offset / pieceLength), Math.floor((offset + file.length - 1) / pieceLength)]
        : null
    offset += file.length
    return span
  })
}

/**
 * Which pieces the chosen files need: a piece is needed when any byte of it belongs to one. The
 * pieces at a chosen file's edges hold bytes of its neighbours too; those are fetched with them
 * (a piece is only ever verified whole), then removed when the download is published.
 */
export function wantedPieces(
  files: readonly { length: number }[],
  pieceLength: number,
  chosen: ReadonlySet<number>
): boolean[] {
  const total = files.reduce((sum, file) => sum + file.length, 0)
  const wanted = new Array<boolean>(Math.ceil(total / pieceLength)).fill(false)
  fileSpans(files, pieceLength).forEach((span, index) => {
    if (!span || !chosen.has(index)) return
    for (let piece = span[0]; piece <= span[1]; piece++) wanted[piece] = true
  })
  return wanted
}

/** The files every piece of which is in: downloaded, whatever is chosen. An empty file is. */
export function finishedFiles(
  files: readonly { length: number }[],
  pieceLength: number,
  completed: readonly boolean[]
): Set<number> {
  const finished = new Set<number>()
  fileSpans(files, pieceLength).forEach((span, index) => {
    if (!span || completed.slice(span[0], span[1] + 1).every(Boolean)) finished.add(index)
  })
  return finished
}
