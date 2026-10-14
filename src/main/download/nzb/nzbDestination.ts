import { constants } from 'node:fs'
import { open, rm, rmdir, stat, truncate, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { DownloadFile } from '../downloadFile'
import { claimDestinationPath } from '../paths'

/**
 * Where an NZB downloads: a folder of its files, in place from the start, as a torrent's is.
 * Each article is decoded and written straight to its offset in its file, so files fill in as
 * their articles land, in any order. Their sizes are only known from the articles themselves:
 * publishing cuts each file to the size its yEnc headers gave.
 */
export class NzbDestination extends DownloadFile {
  /** Open files, by index; opened on their first write. */
  private handles = new Map<number, Promise<FileHandle>>()
  /** Files written to since the last sync. */
  private written = new Set<number>()

  /** `names`: its files, by index, in the folder. `totalBytes`: the NZB's own count (see
   * NzbSegmentState), what size() reports once the folder is there. */
  constructor(
    path: string,
    private readonly names: readonly string[],
    private readonly totalBytes: number
  ) {
    super(path)
  }

  /** Claims `name` in `directory`, or the first free `name (N)`, for the download's folder. */
  static async create(
    directory: string,
    name: string,
    names: readonly string[],
    totalBytes: number
  ): Promise<NzbDestination> {
    return new NzbDestination(await claimDestinationPath(directory, name, true), names, totalBytes)
  }

  private pathOf(index: number): string {
    return join(this.path, this.names[index])
  }

  /** Writes one decoded article into file `index`, at `offset`. Never truncates: articles land in
   * any order, each into its own part of the file. */
  async write(index: number, offset: number, data: Buffer): Promise<void> {
    let handle = this.handles.get(index)
    if (!handle) {
      handle = open(this.pathOf(index), constants.O_RDWR | constants.O_CREAT)
      this.handles.set(index, handle)
      // A failed open is tried again by the next write rather than kept.
      handle.catch(() => this.handles.delete(index))
    }
    const file = await handle
    let written = 0
    while (written < data.length) {
      const { bytesWritten } = await file.write(
        data,
        written,
        data.length - written,
        offset + written
      )
      written += bytesWritten
    }
    this.written.add(index)
  }

  /** Once the folder is there, every article has its place: as a torrent's, it reports the
   * download's size. Throws when it's gone. */
  async size(): Promise<number> {
    await stat(this.path)
    return this.totalBytes
  }

  async sync(): Promise<void> {
    const indexes = [...this.written]
    this.written.clear()
    try {
      for (const index of indexes) await (await this.handles.get(index))?.sync()
    } catch (error) {
      for (const index of indexes) this.written.add(index)
      throw error
    }
  }

  /** Closes its files: a run is over (they open again on the next write). */
  async close(): Promise<void> {
    await this.sync().catch(() => {})
    const handles = [...this.handles.values()]
    this.handles.clear()
    await Promise.all(handles.map(async (handle) => (await handle).close().catch(() => {})))
  }

  /** Each file cut to its real size (`sizes`, by index; unset for one no article of came in),
   * and synced. */
  private async finish(sizes: readonly (number | undefined)[]): Promise<void> {
    await this.close()
    for (const [index, size] of sizes.entries()) {
      if (size === undefined) continue
      await truncate(this.pathOf(index), size).catch((error: NodeJS.ErrnoException) => {
        // A file with every article missing was never written: there's nothing to cut.
        if (error.code !== 'ENOENT') throw error
      })
    }
    for (const index of sizes.keys()) {
      const handle = await open(this.pathOf(index), 'r+').catch(() => null)
      if (!handle) continue
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  }

  /** Its files' real sizes, by index, as the download has learned them (see finish). */
  fileSizes: () => readonly (number | undefined)[] = () => []

  /** Already in place: its files are cut to size (see finish), and it stays where it is. */
  async publish(
    _destinationPath: string,
    _expectedBytes: number,
    beforeAttempt: (candidate: string) => Promise<void>
  ): Promise<string> {
    await this.finish(this.fileSizes())
    await beforeAttempt(this.path)
    return this.path
  }

  /** It is what was published: nothing is left over. */
  discardLeftover(): Promise<void> {
    return Promise.resolve()
  }

  /** Its own files, and the folder once that leaves it empty. Anything else put in it stays. */
  async discard(): Promise<void> {
    await this.close()
    for (const index of this.names.keys()) await rm(this.pathOf(index), { force: true })
    await rmdir(this.path).catch(() => {})
  }
}
