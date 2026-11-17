/** Turning a torrent's file paths into the folder tree the file list shows. Pure. */

import type { TorrentInfo } from '@shared/types'

/** A file in the tree, carrying its index into the torrent's file list. */
export interface FileNode {
  kind: 'file'
  name: string
  path: string
  /** How deep it sits, for the row's indent. */
  depth: number
  index: number
  length: number
}

/** A folder in the tree, with every file under it (at any depth). */
export interface DirNode {
  kind: 'dir'
  name: string
  /** The folder's path within the torrent, e.g. "Show/Season 1"; its identity for a collapse. */
  path: string
  depth: number
  children: TreeNode[]
  /** The indexes of every file under it, so ticking the folder ticks them all. */
  fileIndices: number[]
}

export type TreeNode = DirNode | FileNode

/** A folder as it's built: its subfolders by name, and the files directly in it. */
interface DirDraft {
  dirs: Map<string, DirDraft>
  files: FileNode[]
}

/** The torrent's files as a tree, from their paths. Every file keeps its index into `files`, so a
 * choice made in the tree is still expressed as indexes. A torrent's paths are already known to be
 * safe and relative (see main/download/torrent/paths.ts). */
export function buildTree(files: TorrentInfo['files']): TreeNode[] {
  const root: DirDraft = { dirs: new Map(), files: [] }
  files.forEach((file, index) => {
    const segments = file.path.replace(/\\/g, '/').split('/')
    const name = segments.pop() ?? file.path
    let draft = root
    for (const segment of segments) {
      let next = draft.dirs.get(segment)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        draft.dirs.set(segment, next)
      }
      draft = next
    }
    draft.files.push({ kind: 'file', name, path: file.path, depth: 0, index, length: file.length })
  })

  const toNodes = (draft: DirDraft, parentPath: string, depth: number): TreeNode[] => {
    const nodes: TreeNode[] = []
    for (const [name, child] of draft.dirs) {
      const path = parentPath ? `${parentPath}/${name}` : name
      const children = toNodes(child, path, depth + 1)
      nodes.push({
        kind: 'dir',
        name,
        path,
        depth,
        children,
        fileIndices: children.flatMap((entry) =>
          entry.kind === 'file' ? [entry.index] : entry.fileIndices
        )
      })
    }
    // Files after the folders, as a file manager lists them.
    for (const file of draft.files) nodes.push({ ...file, depth })
    return nodes
  }

  return toNodes(root, '', 0)
}

/** The tree flattened to the rows on screen: a folder's children are left out while it's shut. */
export function visibleRows(tree: TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const rows: TreeNode[] = []
  const walk = (nodes: TreeNode[]): void => {
    for (const node of nodes) {
      rows.push(node)
      if (node.kind === 'dir' && !collapsed.has(node.path)) walk(node.children)
    }
  }
  walk(tree)
  return rows
}

/** The checkbox a folder gets: in when every file under it is chosen, out when none is, and
 * indeterminate in between. Files already downloaded count as chosen and can't be turned off. */
export function folderState(
  node: DirNode,
  isFinished: (index: number) => boolean,
  isChosen: (index: number) => boolean
): { checked: boolean; indeterminate: boolean } {
  const selectable = node.fileIndices.filter((index) => !isFinished(index))
  const chosen = selectable.filter((index) => isChosen(index)).length
  return {
    checked: chosen === selectable.length,
    indeterminate: chosen > 0 && chosen < selectable.length
  }
}

/** Tick or untick every not-yet-downloaded file in `indices`, left as indexes skipped. Downloaded
 * files are never added to `skipped`: skipping one that's already in means nothing. */
export function applyChoice(
  skipped: ReadonlySet<number>,
  indices: readonly number[],
  chosen: boolean,
  isFinished: (index: number) => boolean
): number[] {
  const next = new Set(skipped)
  for (const index of indices) {
    if (isFinished(index)) continue
    if (chosen) next.delete(index)
    else next.add(index)
  }
  return [...next]
}
