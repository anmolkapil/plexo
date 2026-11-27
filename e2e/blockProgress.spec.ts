import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { advanceBlock, retractBlock, rewindBlocks } from '../src/main/download/blockProgress'
import { DownloadFile } from '../src/main/download/downloadFile'
import { reserveDestinationPath } from '../src/main/download/paths'
import type { HttpBlockState } from '../src/shared/types'

// K. What a block's byte counts mean when two attempts race for it, and how range writes land
// in the one destination-side staging file.

const LENGTH = 1000
const fresh = (): HttpBlockState => ({
  kind: 'http',
  index: 0,
  rangeStart: 0,
  rangeEnd: LENGTH - 1,
  status: 'downloading',
  bytesDownloaded: 0,
  bytesByInterface: {}
})
const attributed = (block: HttpBlockState): number =>
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

  test('rewindBlocks resets partial blocks and the last N completed blocks', () => {
    const blocks: HttpBlockState[] = Array.from({ length: 6 }, (_, index): HttpBlockState => ({
      kind: 'http',
      index,
      rangeStart: index * LENGTH,
      rangeEnd: (index + 1) * LENGTH - 1,
      status: index < 3 ? 'completed' : index === 3 ? 'downloading' : 'pending',
      interfaceId: index < 4 ? 'a' : undefined,
      bytesDownloaded: index < 3 ? LENGTH : index === 3 ? 400 : 0,
      bytesByInterface: index < 3 ? { a: LENGTH } : index === 3 ? { a: 400 } : {}
    }))

    expect(rewindBlocks(blocks, 2)).toBe(3)
    expect(blocks[0]).toMatchObject({
      status: 'completed',
      bytesDownloaded: LENGTH,
      bytesByInterface: { a: LENGTH },
      interfaceId: 'a'
    })
    for (const i of [1, 2, 3]) {
      expect(blocks[i]).toMatchObject({
        status: 'pending',
        bytesDownloaded: 0,
        bytesByInterface: {},
        interfaceId: undefined
      })
    }
    expect(blocks[4].status).toBe('pending')

    // Edge cases: N = 0 only clears partials; N > completed count clears all remaining completed.
    expect(rewindBlocks(blocks, 0)).toBe(0)
    expect(rewindBlocks(blocks, 10)).toBe(1)
    expect(blocks[0].status).toBe('pending')
  })
})

test.describe('destination-side staging file', () => {
  let dir: string
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plexo-staging-'))
  })
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const bytes = (from: number, to: number): Buffer =>
    Buffer.from(Array.from({ length: to - from }, (_, i) => (from + i) % 251))

  test('only the .plexo file is visible until completion, and it reserves the name', async () => {
    const first = await reserveDestinationPath(dir, 'result.bin')
    const second = await reserveDestinationPath(dir, 'result.bin')
    expect(first).toBe(join(dir, 'result.bin'))
    expect(second).toBe(join(dir, 'result (1).bin'))
    expect(await readFile(`${first}.plexo`)).toHaveLength(0)
    expect(await readFile(`${second}.plexo`)).toHaveLength(0)
    await expect(readFile(first)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a long name with a dot early in it is shortened, not refused', async () => {
    for (const name of [
      `St. Louis Cardinals vs Chicago Cubs full game replay ${'x'.repeat(200)}`,
      `1. ${'漢'.repeat(85)}`
    ]) {
      const first = await reserveDestinationPath(dir, name)
      const second = await reserveDestinationPath(dir, name)
      expect(Buffer.byteLength(`${basename(first)}.plexo`)).toBeLessThanOrEqual(255)
      expect(basename(second)).toBe(`${basename(first)} (1)`)
      expect(name.startsWith(basename(first))).toBe(true)
    }
    // A real extension still stays last.
    const video = await reserveDestinationPath(dir, `${'a'.repeat(300)}.mkv`)
    expect(basename(video)).toMatch(/^a+\.mkv$/)
  })

  test('out-of-order ranges and a racing hedge produce one exact file', async () => {
    const destination = join(dir, 'result.bin')
    const file = new DownloadFile(`${destination}.plexo`)
    await writeFile(file.path, '')
    const write = (position: number, data: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        const writer = file.writer(position)
        writer.once('error', reject).once('close', resolve)
        writer.end(data)
      })
    // A later block lands first; then a primary and a hedge that began further in write over the
    // same range at once, the same bytes in whichever order the disk takes them.
    await write(500, bytes(500, LENGTH))
    await Promise.all([write(0, bytes(0, 600)), write(400, bytes(400, 600))])
    expect(await file.read(390, 20)).toEqual(bytes(390, 410))
    expect(await readFile(file.path)).toEqual(bytes(0, LENGTH))
    expect(await file.publish(destination, LENGTH, async () => {})).toBe(destination)
    await file.discard()
    expect(await readFile(destination)).toEqual(bytes(0, LENGTH))
  })

  test('publishing does not replace a final file created during the download', async () => {
    const destination = join(dir, 'result.bin')
    const file = new DownloadFile(`${destination}.plexo`)
    await writeFile(file.path, bytes(0, LENGTH))
    await writeFile(destination, 'someone else owns this name')

    const published = await file.publish(destination, LENGTH, async () => {})
    expect(published).toBe(join(dir, 'result (1).bin'))
    expect(await readFile(destination, 'utf-8')).toBe('someone else owns this name')
    expect(await readFile(published)).toEqual(bytes(0, LENGTH))
    await file.discard()
  })
})
