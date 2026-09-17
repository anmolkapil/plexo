import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { pieceLengthAt, type TorrentInfo } from './torrentInfo'

export interface AssembleOptions {
  info: TorrentInfo
  /** Directory holding the verified `part-N` files. */
  partsDir: string
  /** For a single-file torrent, the file to write. For a multi-file torrent, the directory
   * to build the tree inside. */
  destinationPath: string
}

/** Yields each piece's bytes in order, refusing any part file that isn't the exact size its
 * piece should be — a short part would shift every byte after it in the output. */
async function* readPieces(info: TorrentInfo, partsDir: string): AsyncGenerator<Buffer> {
  for (let index = 0; index < info.pieceHashes.length; index += 1) {
    const expectedBytes = pieceLengthAt(info, index)
    const data = await readFile(join(partsDir, `part-${index}`))
    if (data.length !== expectedBytes) {
      throw new Error(
        `Piece ${index} is ${data.length} bytes but should be ${expectedBytes} — refusing to write a corrupt file`
      )
    }
    yield data
  }
}

/** Hands out the piece stream in slices of at most `maxBytes`, spanning piece boundaries. */
function createSliceReader(
  pieces: AsyncGenerator<Buffer>
): (maxBytes: number) => Promise<Buffer | null> {
  let current: Buffer | null = null
  let offset = 0

  return async (maxBytes: number): Promise<Buffer | null> => {
    while (current === null || offset >= current.length) {
      const next = await pieces.next()
      if (next.done) return null
      current = next.value
      offset = 0
    }

    const end = Math.min(current.length, offset + maxBytes)
    const slice = current.subarray(offset, end)
    offset = end
    return slice
  }
}

function writeWithBackpressure(output: WriteStream, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const flushed = output.write(data, (error) => {
      if (error) reject(error)
      else if (flushed) resolve()
    })
    if (!flushed) output.once('drain', resolve)
  })
}

/**
 * Writes a completed torrent's pieces out as its real files.
 *
 * A torrent's pieces tile one continuous byte stream, and its files are just offsets into
 * that stream — a single file spanning all of it, or many files whose boundaries fall
 * wherever they like inside a piece. So this walks the files in order and pulls exactly each
 * one's length off the stream, rather than assuming any file lines up with a piece.
 *
 * Nothing partial is left behind on failure: a half-written file where the user expects
 * their download is worse than no file at all, because it looks like the real thing.
 */
export async function assembleTorrentFiles(options: AssembleOptions): Promise<void> {
  const { info, partsDir, destinationPath } = options

  const pieces = readPieces(info, partsDir)
  const readSlice = createSliceReader(pieces)
  const written: string[] = []
  let totalWritten = 0

  try {
    for (const file of info.files) {
      // A single-file torrent writes to the exact path already reserved for it; a
      // multi-file one builds its tree under that path as a directory.
      const filePath = info.isSingleFile ? destinationPath : join(destinationPath, ...file.path)
      await mkdir(dirname(filePath), { recursive: true })

      const output = createWriteStream(filePath)
      written.push(filePath)

      // Attached before the first write and kept for the stream's life: an unhandled
      // 'error' on a stream takes down the main process rather than failing one download.
      const outputErrors: Error[] = []
      output.on('error', (error: Error) => outputErrors.push(error))

      try {
        let remaining = file.length
        while (remaining > 0) {
          const slice = await readSlice(remaining)
          if (slice === null) {
            throw new Error(
              `Ran out of downloaded data ${remaining} bytes before the end of "${file.path.join('/')}"`
            )
          }
          await writeWithBackpressure(output, slice)
          if (outputErrors.length > 0) throw outputErrors[0]
          remaining -= slice.length
          totalWritten += slice.length
        }

        output.end()
        await finished(output)
        if (outputErrors.length > 0) throw outputErrors[0]
      } catch (error) {
        output.destroy()
        await finished(output).catch(() => {})
        throw error
      }
    }

    if (totalWritten !== info.totalLength) {
      throw new Error(
        `Assembled ${totalWritten} bytes but the torrent is ${info.totalLength} — refusing to keep a corrupt download`
      )
    }
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})))
    throw error
  } finally {
    await pieces.return(undefined)
  }
}
