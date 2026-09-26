import { app } from 'electron'
import { lstat, mkdir, open, rm, stat } from 'node:fs/promises'
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sanitizeFileName(fileName: string): string {
  // A server-provided name is one component, never a path or NTFS data stream.
  let safe = fileName.replace(/[\\/]/g, '_').replace(/\p{Cc}/gu, '_')
  if (process.platform === 'win32') {
    safe = safe.replace(/[<>:"|?*]/g, '_').replace(/[ .]+$/, '')
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`
  }
  return !safe || /^\.+$/.test(safe) ? 'download' : safe
}

export async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true })
  } catch (error) {
    // Windows throws EPERM when trying to mkdir a drive root
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      const stats = await stat(directory).catch(() => null)
      if (stats?.isDirectory()) return
    }
    throw error
  }
}

/**
 * Claims a download by exclusively creating <final name>.plexo. The final name
 * itself does not appear until the file is complete. An existing partial file
 * also claims its corresponding final name, including after a restart.
 */
export async function reserveDestinationPath(directory: string, fileName: string): Promise<string> {
  await ensureDirectory(directory)
  fileName = sanitizeFileName(fileName)
  const ext = extname(fileName)
  // Leave room for " (9999).plexo" within the usual 255-byte component limit.
  const suffixRoom = Buffer.byteLength(' (9999).plexo')
  const maxBaseBytes = 255 - suffixRoom - Buffer.byteLength(ext)
  if (maxBaseBytes <= 0) throw new Error('The file extension is too long')
  const baseCharacters = Array.from(basename(fileName, ext))
  while (Buffer.byteLength(baseCharacters.join('')) > maxBaseBytes) baseCharacters.pop()
  const base = baseCharacters.join('')

  for (let counter = 0; counter < MAX_NAME_ATTEMPTS; counter += 1) {
    const candidate =
      counter === 0
        ? join(directory, `${base}${ext}`)
        : join(directory, `${base} (${counter})${ext}`)
    if (await pathExists(candidate)) continue
    try {
      const handle = await open(`${candidate}.plexo`, 'wx+')
      await handle.close()
      if (await pathExists(candidate)) {
        await rm(`${candidate}.plexo`)
        continue
      }
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  throw new Error(`Could not find an unused file name for "${fileName}" in ${directory}`)
}
