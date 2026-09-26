import { createWriteStream, type WriteStream } from 'node:fs'
import { lstat, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'

/** The only large file owned by a download. It lives beside the final file so publishing it
 * requires no copy and never needs a second file's worth of disk space. */
export class DownloadFile {
  constructor(readonly path: string) {}

  /** Every writer has its own descriptor and explicit offset. Never use append mode here. */
  writer(position: number): WriteStream {
    return createWriteStream(this.path, { flags: 'r+', start: position })
  }

  async read(position: number, length: number): Promise<Buffer> {
    const handle = await open(this.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  /** Flushes the staging file before a recovery checkpoint or final publication. */
  async sync(): Promise<void> {
    const handle = await open(this.path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async size(): Promise<number> {
    return (await stat(this.path)).size
  }

  async publish(
    destinationPath: string,
    expectedBytes: number,
    beforeAttempt: (candidate: string) => Promise<void>
  ): Promise<string> {
    if (expectedBytes > 0 && (await this.size()) !== expectedBytes) {
      throw new Error('Download file size does not match the expected size')
    }
    await this.sync()
    const extension = extname(destinationPath)
    const stem = basename(destinationPath, extension)
    const directory = dirname(destinationPath)
    for (let index = 0; index < 10_000; index += 1) {
      const suffix = index === 0 ? '' : ` (${index})`
      if (Buffer.byteLength(`${suffix}${extension}`) >= 255) {
        throw new Error('The file extension is too long')
      }
      const candidateCharacters = Array.from(stem)
      while (Buffer.byteLength(`${candidateCharacters.join('')}${suffix}${extension}`) > 255) {
        candidateCharacters.pop()
      }
      const candidateStem = candidateCharacters.join('')
      const candidate = join(directory, `${candidateStem}${suffix}${extension}`)
      if (candidate !== destinationPath) {
        const partialExists = await lstat(`${candidate}.plexo`).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false
            throw error
          }
        )
        if (partialExists) continue
      }
      await beforeAttempt(candidate)
      // Check immediately before the rename, after the recovery intent is saved.
      // Node has no portable no-replace rename: another process could still
      // claim this name in the small interval between these two operations.
      const destinationExists = await lstat(candidate).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw error
        }
      )
      if (destinationExists) continue
      try {
        // The partial and final names are in one directory, so this moves the
        // completed bytes into place without copying the file.
        await rename(this.path, candidate)
        return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('Could not find an unused file name for this download')
  }

  async discard(): Promise<void> {
    await rm(this.path, { force: true })
  }
}
