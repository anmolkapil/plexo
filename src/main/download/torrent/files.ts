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
  let offset = 0
  files.forEach((file, index) => {
    if (chosen.has(index) && file.length > 0) {
      const last = Math.floor((offset + file.length - 1) / pieceLength)
      for (let piece = Math.floor(offset / pieceLength); piece <= last; piece++) {
        wanted[piece] = true
      }
    }
    offset += file.length
  })
  return wanted
}
