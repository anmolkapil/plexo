import { app } from 'electron'
import { mkdir, open } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export function getDefaultDownloadsDir(): string {
  return app.getPath('downloads')
}

export function getHomeDir(): string {
  return app.getPath('home')
}

// Somewhere to stop rather than spin forever if every candidate is taken
// (or if something outside the app is creating them as fast as we try).
const MAX_NAME_ATTEMPTS = 10_000

function sanitizeFileName(fileName: string): string {
  // A server-provided name is one component, never a path or NTFS data stream.
  let safe = fileName.replace(/[\\/]/g, '_').replace(/\p{Cc}/gu, '_')
  if (process.platform === 'win32') {
    safe = safe.replace(/[<>:"|?*]/g, '_').replace(/[ .]+$/, '')
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`
  }
  return !safe || /^\.+$/.test(safe) ? 'download' : safe
}

/**
 * Claims <directory>/<fileName>, or <directory>/<fileName> (1), (2), ... if it
 * already exists, by creating an empty file at that path.
 *
 * Creating it is the point. A download's bytes go to part files and only reach
 * the destination at reassembly, so merely *checking* that a name is free
 * leaves it free: two downloads of the same file name started minutes apart
 * would both pick it, and the one that finished second would overwrite the
 * first — or, if their assemblies overlapped, both would write into one file
 * and neither would survive. An exclusive create is what makes the name ours.
 *
 * The caller owns the placeholder from here: it must be removed if the
 * download doesn't end up producing a file.
 */
export async function ensureDirectoryExists(directory: string): Promise<void> {
  const { parse, resolve } = await import('node:path')
  const resolvedDir = resolve(directory)
  const resolvedRoot = resolve(parse(directory).root)
  if (resolvedDir !== resolvedRoot) {
    await mkdir(directory, { recursive: true })
  }
}

export async function reserveDestinationPath(directory: string, fileName: string): Promise<string> {
  await ensureDirectoryExists(directory)
  fileName = sanitizeFileName(fileName)
  const ext = extname(fileName)
  const base = basename(fileName, ext)

  for (let counter = 0; counter < MAX_NAME_ATTEMPTS; counter += 1) {
    const candidate =
      counter === 0 ? join(directory, fileName) : join(directory, `${base} (${counter})${ext}`)
    try {
      const handle = await open(candidate, 'wx')
      await handle.close()
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  throw new Error(`Could not find an unused file name for "${fileName}" in ${directory}`)
}
