import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { advanceBlock, retractBlock } from '../src/main/download/blockProgress'
import { hedgeFile, mergeHedge, partFile, removeHedgeFiles } from '../src/main/download/partFiles'
import type { BlockState } from '../src/shared/types'

// K. What a block's byte counts mean when two attempts race for it, and how a racing attempt's
// file joins the block's own.

const LENGTH = 1000
const fresh = (): BlockState => ({
  index: 0,
  rangeStart: 0,
  rangeEnd: LENGTH - 1,
  status: 'downloading',
  bytesDownloaded: 0,
  bytesByInterface: {}
})
const attributed = (block: BlockState): number =>
  Object.values(block.bytesByInterface).reduce((sum, bytes) => sum + bytes, 0)

test.describe('block progress', () => {
  test('two attempts racing count only the ground the furthest one covers', () => {
    const block = fresh()
    expect(advanceBlock(block, 'a', 300)).toBe(300)
    expect(advanceBlock(block, 'b', 200)).toBe(0) // behind: nothing new
    expect(advanceBlock(block, 'b', 500)).toBe(200) // only what goes past a
    expect(block.bytesDownloaded).toBe(500)
    expect(block.bytesByInterface).toEqual({ a: 300, b: 200 })
  })

  test('the frontier never passes the block’s end', () => {
    const block = fresh()
    advanceBlock(block, 'a', LENGTH + 500)
    expect(block.bytesDownloaded).toBe(LENGTH)
  })

  test('retracting takes the bytes off the network they came from first', () => {
    const block = fresh()
    advanceBlock(block, 'a', 300)
    advanceBlock(block, 'b', 500)
    expect(retractBlock(block, 300, 'b')).toBe(200)
    expect(block.bytesByInterface).toEqual({ a: 300 })
  })

  test('however attempts advance and retract, attribution adds up to the frontier', () => {
    const step = fc.oneof(
      fc.record({
        op: fc.constant('advance' as const),
        network: fc.constantFrom('a', 'b', 'c'),
        position: fc.integer({ min: 0, max: LENGTH + 200 })
      }),
      fc.record({
        op: fc.constant('retract' as const),
        network: fc.constantFrom('a', 'b', 'c'),
        position: fc.integer({ min: 0, max: LENGTH })
      })
    )
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const block = fresh()
        for (const { op, network, position } of steps) {
          if (op === 'advance') advanceBlock(block, network, position)
          else retractBlock(block, position, network)
          expect(attributed(block)).toBe(block.bytesDownloaded)
          expect(block.bytesDownloaded).toBeGreaterThanOrEqual(0)
          expect(block.bytesDownloaded).toBeLessThanOrEqual(LENGTH)
        }
      })
    )
  })
})

test.describe('joining a racing attempt onto its block', () => {
  let dir: string
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plexo-merge-'))
  })
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const bytes = (from: number, to: number): Buffer =>
    Buffer.from(Array.from({ length: to - from }, (_, i) => (from + i) % 251))

  test('keeps the block’s first bytes and appends the hedge’s, dropping what the block’s writer got past the join', async () => {
    const part = partFile(dir, 3)
    const hedge = hedgeFile(dir, 3, 7)
    // The block's writer got to 600 before it was stopped; the hedge began at 400.
    await writeFile(part, bytes(0, 600))
    await writeFile(hedge, bytes(400, LENGTH))
    expect(await mergeHedge(part, hedge, 400, LENGTH)).toBe(true)
    expect(await readFile(part)).toEqual(bytes(0, LENGTH))
  })

  test('a hedge that began at the very start becomes the block', async () => {
    const part = partFile(dir, 0)
    const hedge = hedgeFile(dir, 0, 1)
    await writeFile(hedge, bytes(0, LENGTH)) // no part file at all
    expect(await mergeHedge(part, hedge, 0, LENGTH)).toBe(true)
    expect(await readFile(part)).toEqual(bytes(0, LENGTH))
  })

  test('refuses, changing nothing, when the block’s file is shorter than the join', async () => {
    const part = partFile(dir, 0)
    const hedge = hedgeFile(dir, 0, 1)
    await writeFile(part, bytes(0, 300)) // its writer never flushed the last 100
    await writeFile(hedge, bytes(400, LENGTH))
    expect(await mergeHedge(part, hedge, 400, LENGTH)).toBe(false)
    expect((await stat(part)).size).toBe(300)
  })

  test('refuses, changing nothing, when the hedge’s file is not the size its range says', async () => {
    const part = partFile(dir, 0)
    const hedge = hedgeFile(dir, 0, 1)
    await writeFile(part, bytes(0, 500))
    await writeFile(hedge, bytes(400, 900))
    expect(await mergeHedge(part, hedge, 400, LENGTH)).toBe(false)
    expect(await readFile(part)).toEqual(bytes(0, 500))
  })

  test('leftover hedge files are cleared without touching the blocks’ own', async () => {
    await writeFile(partFile(dir, 1), 'keep')
    await writeFile(hedgeFile(dir, 1, 4), 'stale')
    await writeFile(hedgeFile(dir, 2, 0), 'stale')
    await removeHedgeFiles(dir)
    expect((await stat(partFile(dir, 1))).size).toBe(4)
    await expect(stat(hedgeFile(dir, 1, 4))).rejects.toThrow()
    await expect(stat(hedgeFile(dir, 2, 0))).rejects.toThrow()
  })
})
