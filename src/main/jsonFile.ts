import { readFile, rename, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const writeChains = new Map<string, Promise<unknown>>()

/** Parsed contents, or undefined when the file is missing (first run) or corrupt. Any other
 * failure (a lock, too many open files) throws, so a save never overwrites what it couldn't read.
 * Waits for queued writes first, so a read right after a save (e.g. a reload) sees it. */
export async function readJson(path: string): Promise<unknown> {
  await writeChains.get(path)?.catch(() => {})
  return readJsonNow(path)
}

async function readJsonNow(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** On Windows, antivirus/indexers/sync clients briefly hold files open, which fails a rename
 * over them — worth a few short retries before giving up on the save. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw error
      await sleep(50 * (attempt + 1))
    }
  }
}

/** Read-modify-write, queued per file so two quick saves can't drop each other's change, and
 * written via a temp file + rename so a crash mid-write can't leave a half-written file (which
 * would read back as corrupt and wipe every saved value). The temp name is per process, so a
 * second running instance can't truncate it mid-rename. */
export function updateJson(path: string, update: (current: unknown) => unknown): Promise<void> {
  const next = (writeChains.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const value = update(await readJsonNow(path))
      const temporaryPath = `${path}.${process.pid}.tmp`
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf-8')
      await renameWithRetry(temporaryPath, path)
    })
  writeChains.set(path, next)
  return next
}
