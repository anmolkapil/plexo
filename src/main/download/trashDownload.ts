import { rmdir } from 'node:fs/promises'
import { shell } from 'electron'
import type { DownloadState, FinishedDownload } from '../../shared/types'
import { ownedTorrentFiles } from './torrent/ownedFiles'

/** Trash only owned torrent files; never move unrelated files added to its folder. */
export async function trashDownload(
  download: DownloadState | FinishedDownload,
  ownedFiles?: readonly string[]
): Promise<void> {
  if (download.kind !== 'torrent' || !download.folder) {
    await shell.trashItem(download.destinationPath)
    return
  }
  const files = ownedFiles ?? ('downloadedFiles' in download ? download.downloadedFiles : undefined)
  if (!files?.length) {
    throw new Error(
      'Plexo can’t identify the files in this older torrent. Remove it from the list or manage its files in your file browser.'
    )
  }
  const { targets, folders } = await ownedTorrentFiles(download.destinationPath, files)
  for (const target of targets) await shell.trashItem(target)
  for (const folder of folders) await rmdir(folder).catch(() => {})
}
