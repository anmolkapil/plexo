import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  DEFAULT_MAX_BLOCK_BYTES,
  interleave,
  MAX_STREAMS_PER_NETWORK,
  MIN_BLOCK_BYTES,
  planDownload,
  START_STREAMS_PER_NETWORK,
  startingStreams
} from '../src/main/download/plan'

// I. How a download is cut into blocks, and how many streams a network starts on them. Pure, so
// it's checked over the whole input space instead of hand-picked sizes.

const MIB = 1024 * 1024

const splittable = fc.record({
  totalBytes: fc.integer({ min: 1, max: 2 ** 42 }),
  splittable: fc.constant(true),
  networkCount: fc.integer({ min: 1, max: 6 })
})

test.describe('download plan', () => {
  test('blocks tile the file exactly, within the size limits', () => {
    fc.assert(
      fc.property(splittable, (request) => {
        const plan = planDownload(request)
        const { blockSizeBytes, blockCount } = plan
        expect(blockSizeBytes * blockCount).toBeGreaterThanOrEqual(request.totalBytes)
        expect(blockSizeBytes * (blockCount - 1)).toBeLessThan(request.totalBytes)
        expect(blockSizeBytes).toBeGreaterThanOrEqual(Math.min(MIN_BLOCK_BYTES, request.totalBytes))
        // However big the file: a bigger file gets more blocks, never bigger ones.
        expect(blockSizeBytes).toBeLessThanOrEqual(DEFAULT_MAX_BLOCK_BYTES)
      })
    )
  })

  test('a joining network gets a stream, and never one with no block to claim', () => {
    fc.assert(
      fc.property(
        fc.nat(10_000),
        fc.integer({ min: 1, max: 6 }),
        fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
        (waiting, networkCount, requested) => {
          const count = startingStreams(waiting, networkCount, requested)
          expect(count).toBeGreaterThanOrEqual(1)
          expect(count).toBeLessThanOrEqual(requested ?? START_STREAMS_PER_NETWORK)
          expect(count).toBeLessThanOrEqual(MAX_STREAMS_PER_NETWORK)
          // Streams beyond the waiting blocks would idle — except the one each network keeps.
          expect(count).toBeLessThanOrEqual(Math.max(1, Math.ceil(waiting / networkCount)))
        }
      )
    )
  })

  test('a file too small to split is one block, and each network still gets a stream', () => {
    const plan = planDownload({ totalBytes: 300 * 1024, splittable: true, networkCount: 2 })
    expect(plan.blockCount).toBe(1)
    expect(startingStreams(plan.blockCount, 2, 8)).toBe(1)
  })

  test('a large file keeps 8 MB blocks', () => {
    const plan = planDownload({ totalBytes: 4 * 1024 * MIB, splittable: true, networkCount: 2 })
    expect(plan.blockSizeBytes).toBe(DEFAULT_MAX_BLOCK_BYTES)
  })

  test('each network starts with eight streams, with blocks enough to grow to its limit', () => {
    const plan = planDownload({ totalBytes: 512 * MIB, splittable: true, networkCount: 2 })
    expect(startingStreams(plan.blockCount, 2)).toBe(8)
    // Streams added later need waiting blocks to take: two each, at the most every network can have.
    expect(plan.blockCount).toBeGreaterThanOrEqual(2 * MAX_STREAMS_PER_NETWORK * 2)
  })

  test('a mid-size file is cut so a fast network can out-pull a slow one', () => {
    const plan = planDownload({
      totalBytes: 12 * MIB,
      splittable: true,
      networkCount: 2
    })
    // Two 8 MB-ish blocks would pin a third of the file to whichever network is slower.
    expect(plan.blockCount).toBeGreaterThanOrEqual(8)
  })

  test('no range support or unknown size: one block', () => {
    for (const request of [
      { totalBytes: 10 * MIB, splittable: false },
      { totalBytes: 0, splittable: true }
    ]) {
      expect(planDownload({ ...request, networkCount: 3 }).blockCount).toBe(1)
    }
  })

  test('interleave serves every group before any twice, keeping each group in order', () => {
    expect(interleave(['a', 'a', 'a', 'b', 'b'], (id) => id)).toEqual(['a', 'b', 'a', 'b', 'a'])
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.nat())), (items) => {
        const out = interleave(items, ([group]) => group)
        expect(out).toHaveLength(items.length)
        for (const group of new Set(items.map(([g]) => g))) {
          expect(out.filter(([g]) => g === group)).toEqual(items.filter(([g]) => g === group))
        }
      })
    )
  })
})
