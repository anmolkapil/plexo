import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  DEFAULT_MAX_BLOCK_BYTES,
  interleave,
  MAX_BLOCKS,
  MAX_STREAMS,
  MAX_STREAMS_PER_NETWORK,
  MIN_BLOCK_BYTES,
  planDownload
} from '../src/shared/plan'

// I. How a download is cut into blocks and streams. Pure, so it's checked over the whole input
// space instead of hand-picked sizes.

const MIB = 1024 * 1024

const splittable = fc.record({
  totalBytes: fc.integer({ min: 1, max: 2 ** 42 }),
  splittable: fc.constant(true),
  networkCount: fc.integer({ min: 1, max: 6 }),
  streamsPerNetwork: fc.integer({ min: 1, max: 12 })
})

test.describe('download plan', () => {
  test('blocks tile the file exactly, within the size limits', () => {
    fc.assert(
      fc.property(splittable, (request) => {
        const plan = planDownload(request)
        const { blockSizeBytes, blockCount } = plan
        expect(blockSizeBytes * blockCount).toBeGreaterThanOrEqual(request.totalBytes)
        expect(blockSizeBytes * (blockCount - 1)).toBeLessThan(request.totalBytes)
        expect(blockCount).toBeLessThanOrEqual(MAX_BLOCKS)
        expect(blockSizeBytes).toBeGreaterThanOrEqual(Math.min(MIN_BLOCK_BYTES, request.totalBytes))
        expect(blockSizeBytes).toBeLessThanOrEqual(
          Math.max(DEFAULT_MAX_BLOCK_BYTES, Math.ceil(request.totalBytes / MAX_BLOCKS))
        )
      })
    )
  })

  test('every network gets a stream, and never one with no block to claim', () => {
    fc.assert(
      fc.property(splittable, (request) => {
        const { streamNetworks, blockCount } = planDownload(request)
        const perNetwork = new Map<number, number>()
        for (const network of streamNetworks) {
          perNetwork.set(network, (perNetwork.get(network) ?? 0) + 1)
        }
        expect(perNetwork.size).toBe(request.networkCount)
        expect(streamNetworks.length).toBeLessThanOrEqual(MAX_STREAMS)
        for (const count of perNetwork.values()) {
          expect(count).toBeLessThanOrEqual(request.streamsPerNetwork)
          expect(count).toBeLessThanOrEqual(MAX_STREAMS_PER_NETWORK)
          // Streams beyond the block count would idle — except the one each network keeps.
          expect(count).toBeLessThanOrEqual(
            Math.max(1, Math.ceil(blockCount / request.networkCount))
          )
        }
      })
    )
  })

  test('streams start fairly: no network is ever more than one ahead of another', () => {
    fc.assert(
      fc.property(splittable, (request) => {
        const { streamNetworks } = planDownload(request)
        const started = new Array<number>(request.networkCount).fill(0)
        for (const network of streamNetworks) {
          started[network]++
          expect(Math.max(...started) - Math.min(...started)).toBeLessThanOrEqual(1)
        }
      })
    )
  })

  test('the first stream on each network starts before any network gets a second', () => {
    const plan = planDownload({
      totalBytes: 50.8 * MIB,
      splittable: true,
      networkCount: 2,
      streamsPerNetwork: 8
    })
    expect(plan.streamNetworks.slice(0, 4)).toEqual([0, 1, 0, 1])
  })

  test('a file too small to split is one block, with every network still listed', () => {
    const plan = planDownload({
      totalBytes: 300 * 1024,
      splittable: true,
      networkCount: 2,
      streamsPerNetwork: 8
    })
    expect(plan.blockCount).toBe(1)
    expect(plan.streamNetworks).toEqual([0, 1])
  })

  test('a large file keeps 8 MB blocks', () => {
    const plan = planDownload({
      totalBytes: 4 * 1024 * MIB,
      splittable: true,
      networkCount: 2,
      streamsPerNetwork: 4
    })
    expect(plan.blockSizeBytes).toBe(DEFAULT_MAX_BLOCK_BYTES)
  })

  test('a mid-size file is cut so a fast network can out-pull a slow one', () => {
    const plan = planDownload({
      totalBytes: 12 * MIB,
      splittable: true,
      networkCount: 2,
      streamsPerNetwork: 2
    })
    // Two 8 MB-ish blocks would pin a third of the file to whichever network is slower.
    expect(plan.blockCount).toBeGreaterThanOrEqual(8)
  })

  test('the test knob for block size still applies', () => {
    const plan = planDownload({
      totalBytes: 40 * 64 * 1024,
      splittable: true,
      networkCount: 1,
      streamsPerNetwork: 4,
      maxBlockBytes: 64 * 1024
    })
    expect(plan.blockSizeBytes).toBe(64 * 1024)
    expect(plan.blockCount).toBe(40)
  })

  test('no range support or unknown size: one stream on the first network', () => {
    for (const request of [
      { totalBytes: 10 * MIB, splittable: false },
      { totalBytes: 0, splittable: true }
    ]) {
      const plan = planDownload({ ...request, networkCount: 3, streamsPerNetwork: 8 })
      expect(plan.blockCount).toBe(1)
      expect(plan.streamNetworks).toEqual([0])
    }
  })

  test('interleave keeps each group in order', () => {
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
