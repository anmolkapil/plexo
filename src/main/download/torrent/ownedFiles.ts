import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** Validate all owned paths before removing any. User-added files and symlink targets are never followed. */
export async function ownedTorrentFiles(
  root: string,
  files: readonly string[]
): Promise<{
  targets: string[]
  folders: string[]
}> {
  const targets: string[] = []
  const folders = new Set<string>([root])
  const inspect = async (path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> =>
    lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
  for (const file of files) {
    const target = join(root, file)
    const within = relative(root, target)
    if (
      !within ||
      isAbsolute(file) ||
      isAbsolute(within) ||
      within === '..' ||
      within.startsWith(`..${sep}`)
    ) {
      throw new Error('Plexo can’t safely remove this torrent’s files.')
    }
    let parent = dirname(target)
    while (true) {
      const info = await inspect(parent)
      if (info?.isSymbolicLink())
        throw new Error('A torrent folder is now a link. Manage its files in your file browser.')
      folders.add(parent)
      if (parent === root) break
      parent = dirname(parent)
    }
    const info = await inspect(target)
    if (info) {
      if (info.isDirectory())
        throw new Error('A torrent file is now a folder. Manage it in your file browser.')
      targets.push(target)
    }
  }
  return { targets, folders: [...folders].sort((a, b) => b.length - a.length) }
}
