import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { FinishedDownload } from '../../shared/types'
import { readJson, updateJson } from '../jsonFile'

// Finished downloads, newest first: what the window lists under Finished. A download moves here
// once it completes, leaving its work units behind (tens of thousands of them for a large file,
// none of any use once it's done), so a long history costs launch nothing.

// ponytail: a fixed cap, oldest dropped; a setting if anyone wants more than this kept.
const MAX_ENTRIES = 500

function historyPath(): string {
  return join(app.getPath('userData'), 'history.json')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file may be hand-edited or from another version: an entry is kept only if it has what the
 * window reads off every entry, and anything else malformed is dropped rather than shown. */
function isEntry(value: unknown): value is FinishedDownload {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    (value.kind === 'http' || value.kind === 'torrent') &&
    typeof value.url === 'string' &&
    typeof value.fileName === 'string' &&
    typeof value.destinationPath === 'string' &&
    typeof value.totalBytes === 'number' &&
    typeof value.bytesDownloaded === 'number' &&
    typeof value.startedAt === 'number' &&
    typeof value.completedAt === 'number' &&
    typeof value.unitsWritten === 'number' &&
    Array.isArray(value.networks) &&
    value.networks.every(isRecord)
  )
}

function entriesOf(parsed: unknown): FinishedDownload[] {
  return Array.isArray(parsed) ? parsed.filter(isEntry) : []
}

/** Every finished download, newest first, each marked `missing` when its file is gone. */
export async function listHistory(): Promise<FinishedDownload[]> {
  const entries = entriesOf(await readJson(historyPath()).catch(() => undefined))
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      missing: !(await stat(entry.destinationPath).then(
        () => true,
        () => false
      ))
    }))
  )
}

/** One finished download, its file checked alone rather than every entry's. */
export async function findInHistory(id: string): Promise<FinishedDownload | undefined> {
  const entry = entriesOf(await readJson(historyPath()).catch(() => undefined)).find(
    (other) => other.id === id
  )
  if (!entry) return undefined
  const missing = !(await stat(entry.destinationPath).then(
    () => true,
    () => false
  ))
  return { ...entry, missing }
}

export function addToHistory(entry: FinishedDownload): Promise<void> {
  const { missing: omitted, ...kept } = entry
  void omitted
  return updateJson(historyPath(), (current) =>
    [kept, ...entriesOf(current).filter((other) => other.id !== entry.id)].slice(0, MAX_ENTRIES)
  )
}

/** Forgets the entries with these ids; none given, every one. The files themselves stay. */
export function removeFromHistory(ids?: string[]): Promise<void> {
  return updateJson(historyPath(), (current) =>
    ids ? entriesOf(current).filter((entry) => !ids.includes(entry.id)) : []
  )
}
