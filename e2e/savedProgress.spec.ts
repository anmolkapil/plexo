import { expect, test } from '@playwright/test'
import { planBlocks } from '../src/main/download/plan'
import { restoreBlocks, saveBlocks } from '../src/main/download/savedProgress'
import type { BlockState } from '../src/shared/types'

// P. What a download's saved progress says, and what it's trusted to say when read back.

const MIB = 1024 * 1024
const plan = { totalBytes: 10 * MIB, blockSizeBytes: 4 * MIB, totalBlocks: 3 }

/** A download of `plan` with some progress: block 0 done by two networks, block 1 partway. */
function inProgress(): BlockState[] {
  const blocks = planBlocks(plan.totalBytes, plan.blockSizeBytes)
  Object.assign(blocks[0], {
    status: 'completed',
    bytesDownloaded: 4 * MIB,
    bytesByInterface: { wifi: 3 * MIB, ethernet: MIB }
  })
  Object.assign(blocks[1], {
    status: 'downloading',
    bytesDownloaded: 1000,
    bytesByInterface: { wifi: 1000 }
  })
  return blocks
}

test.describe('saved progress', () => {
  test('what is saved comes back: progress, attribution, and which blocks are done', () => {
    const restored = restoreBlocks(plan, saveBlocks(inProgress()))!
    expect(restored.map((block) => [block.status, block.bytesDownloaded])).toEqual([
      ['completed', 4 * MIB],
      ['pending', 1000],
      ['pending', 0]
    ])
    expect(restored[0].bytesByInterface).toEqual({ wifi: 3 * MIB, ethernet: MIB })
    expect(restored.map((block) => [block.rangeStart, block.rangeEnd])).toEqual([
      [0, 4 * MIB - 1],
      [4 * MIB, 8 * MIB - 1],
      [8 * MIB, 10 * MIB - 1]
    ])
  })

  test('a finished file of unknown size comes back finished', () => {
    // One open-ended block: its bytes can't say it's done, so the save has to.
    const blocks = planBlocks(0, 0)
    Object.assign(blocks[0], {
      status: 'completed',
      bytesDownloaded: 5000,
      bytesByInterface: { wifi: 5000 }
    })
    const unknownSize = { totalBytes: 0, blockSizeBytes: 0, totalBlocks: 1 }
    expect(restoreBlocks(unknownSize, saveBlocks(blocks))?.[0].status).toBe('completed')
    // And one still going doesn't.
    blocks[0].status = 'downloading'
    expect(restoreBlocks(unknownSize, saveBlocks(blocks))?.[0].status).toBe('pending')
  })

  test('a plan that doesn’t add up is refused, before anything is allocated for it', () => {
    const saved = saveBlocks(inProgress())
    for (const blockSizeBytes of [0, -1, NaN, 1.5, undefined]) {
      expect(
        restoreBlocks({ ...plan, blockSizeBytes }, saved),
        String(blockSizeBytes)
      ).toBeUndefined()
    }
    // A block size of 1 byte would be ten million blocks; the saved count says 3.
    expect(restoreBlocks({ ...plan, blockSizeBytes: 1 }, saved)).toBeUndefined()
    expect(restoreBlocks({ ...plan, totalBlocks: 4 }, saved)).toBeUndefined()
  })

  test('progress that doesn’t fit the plan is dropped, and the blocks start over', () => {
    const good = saveBlocks(inProgress())
    const broken = [
      { wifi: [1, 2] }, // too few blocks
      { wifi: [0.5, 0, 0] }, // part of a byte
      { wifi: [-1, 0, 0] },
      { wifi: [5 * MIB, 0, 0] }, // more than the block holds
      { wifi: [3 * MIB, 0, 0], ethernet: [2 * MIB, 0, 0] }, // together, more than it holds
      { wifi: 'lots' }
    ]
    for (const progress of broken) {
      const restored = restoreBlocks(plan, { ...good, progress } as never)!
      expect(restored, JSON.stringify(progress)).toHaveLength(3)
      expect(
        restored.every((block) => block.bytesDownloaded === 0 && block.status === 'pending')
      ).toBe(true)
    }
  })
})
