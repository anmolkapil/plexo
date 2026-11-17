import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  applyChoice,
  buildTree,
  folderState,
  visibleRows,
  type DirNode,
  type FileNode,
  type TreeNode
} from '../src/renderer/src/utils/torrentTree'

// The torrent file list's tree: paths to folders, which rows show, and the tick on a folder.
// Pure, so it's checked here rather than through the window.

/** Files from their paths, each a size of its own, in the order a torrent lists them. */
const files = (paths: string[]): { path: string; length: number }[] =>
  paths.map((path, index) => ({ path, length: (index + 1) * 1000 }))

const isDir = (node: TreeNode): node is DirNode => node.kind === 'dir'
const isFile = (node: TreeNode): node is FileNode => node.kind === 'file'

/** Every file in the tree, in the order it's shown. */
function filesInOrder(tree: TreeNode[]): FileNode[] {
  return visibleRows(tree, new Set()).filter(isFile)
}

test.describe('torrent file tree', () => {
  test('nested paths become nested folders, files keeping their indexes', () => {
    const tree = buildTree(
      files(['Show/Season 1/a.mkv', 'Show/Season 1/b.mkv', 'Show/Season 2/c.mkv', 'Show/note.txt'])
    )
    expect(tree).toHaveLength(1)
    const show = tree[0]
    expect(isDir(show)).toBe(true)
    if (!isDir(show)) return
    expect(show).toMatchObject({ name: 'Show', path: 'Show', depth: 0 })
    // Every file under it, at any depth, for ticking the folder at once.
    expect(show.fileIndices).toEqual([0, 1, 2, 3])

    // Folders first, then the folder's own files, as a file manager lists them.
    const season1 = show.children[0]
    const season2 = show.children[1]
    const note = show.children[2]
    expect(isDir(season1) && isDir(season2) && isFile(note)).toBe(true)
    if (!isDir(season1) || !isDir(season2) || !isFile(note)) return
    expect(season1).toMatchObject({ name: 'Season 1', path: 'Show/Season 1', depth: 1 })
    expect(season2).toMatchObject({ name: 'Season 2', path: 'Show/Season 2', depth: 1 })
    expect(note).toMatchObject({ name: 'note.txt', index: 3, depth: 1 })

    const a = season1.children[0]
    expect(isFile(a)).toBe(true)
    if (isFile(a)) expect(a).toMatchObject({ name: 'a.mkv', index: 0, depth: 2 })

    // Every file, in order, with the index it came in with.
    expect(filesInOrder(tree).map((file) => file.index)).toEqual([0, 1, 2, 3])
  })

  test('a folder is left out while it is shut, its files back when it is open', () => {
    const tree = buildTree(files(['Show/A/x.bin', 'Show/B/y.bin', 'Show/top.bin']))
    const open = visibleRows(tree, new Set())
    expect(open.map((node) => node.name)).toEqual(['Show', 'A', 'x.bin', 'B', 'y.bin', 'top.bin'])

    const closed = visibleRows(tree, new Set(['Show']))
    expect(closed.map((node) => node.name)).toEqual(['Show'])

    const half = visibleRows(tree, new Set(['Show/A']))
    expect(half.map((node) => node.name)).toEqual(['Show', 'A', 'B', 'y.bin', 'top.bin'])
  })

  test('a folder ticks in, out, or halfway, on the files still to fetch', () => {
    const tree = buildTree(files(['Set/a.bin', 'Set/b.bin']))
    const set = tree[0]
    if (!isDir(set)) throw new Error('expected a folder')
    const noneFinished = (): boolean => false

    expect(folderState(set, noneFinished, () => true)).toEqual({
      checked: true,
      indeterminate: false
    })
    expect(folderState(set, noneFinished, () => false)).toEqual({
      checked: false,
      indeterminate: false
    })
    expect(folderState(set, noneFinished, (index) => index === 0)).toEqual({
      checked: false,
      indeterminate: true
    })

    // a.bin is already in: it counts as chosen, so only b.bin's tick matters.
    const doneA = (index: number): boolean => index === 0
    expect(folderState(set, doneA, () => true)).toEqual({ checked: true, indeterminate: false })
    expect(folderState(set, doneA, (index) => index === 0)).toEqual({
      checked: false,
      indeterminate: false
    })
  })

  test('a folder tick leaves already-downloaded files chosen, whatever is asked', () => {
    const skipped = new Set<number>()
    // File 0 is in already; only file 1 is still to fetch.
    const finished = (index: number): boolean => index === 0
    expect(applyChoice(skipped, [0, 1], false, finished)).toEqual([1])
    expect(applyChoice(new Set([1]), [0, 1], true, finished)).toEqual([])
  })

  test('any set of paths round-trips to its files, in order', () => {
    const pathGen = fc
      .array(fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/), { minLength: 1, maxLength: 4 })
      .map((segments) => segments.join('/'))
    fc.assert(
      fc.property(fc.array(pathGen, { minLength: 1, maxLength: 20 }), (paths) => {
        const tree = buildTree(files(paths))
        const flat = filesInOrder(tree)
        expect(flat).toHaveLength(paths.length)
        // Every original file is there exactly once, with its own index and path.
        expect(new Set(flat.map((file) => file.index))).toEqual(new Set(paths.map((_, i) => i)))
        for (const file of flat) expect(files(paths)[file.index].path).toBe(file.path)
      })
    )
  })
})
