import { truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SimulatedNetworkConfig } from '../src/shared/types'
import { BLOCK, expect, test } from './fixtures'
import { seededBytes, sha256 } from './origin'

// F. The dev-tool simulated download: a local file pushed through the real chunking, retry and
// assembly pipeline, with only the HTTP transfer swapped out (see simDownload.ts).

const SIZE = 40 * BLOCK

async function sourceFile(dir: string, seed: number): Promise<{ path: string; sha: string }> {
  const bytes = seededBytes(SIZE, seed)
  const path = join(dir, '..', `source-${seed}.bin`)
  await writeFile(path, bytes)
  return { path, sha: sha256(bytes) }
}

const network = (label: string, faultRatePercent = 0): SimulatedNetworkConfig => ({
  kind: 'wifi',
  label,
  speedBytesPerSec: 40e6,
  faultRatePercent
})

test.describe('simulated downloads @smoke', () => {
  test('three flaky networks (30% of attempts dropped) still produce the exact file', async ({
    plexo,
    dirs
  }) => {
    const source = await sourceFile(dirs.userData, 1)
    await plexo.startSimulated(
      {
        sourceFilePath: source.path,
        networks: [network('one', 30), network('two', 30), network('three', 30)],
        chunkCount: 6,
        connectionsPerNetwork: 2
      },
      source.sha
    )
    const state = await plexo.waitForStatus('completed', 30_000)
    expect(state.chunks.reduce((sum, chunk) => sum + chunk.retryCount, 0)).toBeGreaterThan(0)
  })

  test('a file with fewer blocks than streams still gives every network work', async ({
    plexo,
    dirs
  }) => {
    // 7 blocks against 16 requested streams: the first network's streams used to claim every
    // block before the second network's had started, leaving it idle for the whole download.
    const bytes = seededBytes(7 * BLOCK, 3)
    const path = join(dirs.userData, '..', 'source-small.bin')
    await writeFile(path, bytes)
    await plexo.startSimulated(
      {
        sourceFilePath: path,
        networks: [network('one'), network('two')],
        chunkCount: 16,
        connectionsPerNetwork: 8
      },
      sha256(bytes)
    )
    const state = await plexo.waitForStatus('completed')

    const delivered = new Map<string, number>()
    for (const chunk of state.chunks) delivered.set(chunk.interfaceId, 0)
    for (const block of state.blocks ?? []) {
      for (const [id, size] of Object.entries(block.bytesByInterface)) {
        delivered.set(id, (delivered.get(id) ?? 0) + size)
      }
    }
    expect(delivered.size, 'both networks are listed').toBe(2)
    for (const [id, size] of delivered) expect(size, `${id} delivered bytes`).toBeGreaterThan(0)
    // 16 streams were asked for, but a stream with no block to claim would only idle: each
    // network gets as many as its share of the 7 blocks (4).
    for (const id of delivered.keys()) {
      expect(state.chunks.filter((chunk) => chunk.interfaceId === id)).toHaveLength(4)
    }
  })

  test('a part that goes wrong during assembly fails the download and leaves nothing behind', async ({
    plexo,
    dirs
  }) => {
    const source = await sourceFile(dirs.userData, 5)
    const id = await plexo.startSimulated(
      {
        sourceFilePath: source.path,
        networks: [network('one')],
        chunkCount: 2,
        connectionsPerNetwork: 2,
        assembleSpeedBytesPerSec: SIZE / 2
      },
      source.sha
    )
    await plexo.waitForStatus('assembling')
    // The last part is still waiting its turn; cut a byte off it.
    const last = join(dirs.userData, 'downloads', id, 'parts', `part-${SIZE / BLOCK - 1}`)
    await truncate(last, BLOCK - 1)

    const state = await plexo.waitForStatus('error')
    expect(state.error).toMatch(/refusing to write a corrupt file/)
    // (the automatic checks then confirm there is no file at the destination and no parts left)
  })

  test('pause and cancel are ignored while assembling', async ({ plexo, dirs }) => {
    const source = await sourceFile(dirs.userData, 2)
    const id = await plexo.startSimulated(
      {
        sourceFilePath: source.path,
        networks: [network('one')],
        chunkCount: 2,
        connectionsPerNetwork: 2,
        assembleSpeedBytesPerSec: SIZE / 2
      },
      source.sha
    )
    await plexo.waitForStatus('assembling')
    await plexo.api.pauseDownload(id)
    await plexo.api.cancelDownload(id)
    expect((await plexo.current())?.status).toBe('assembling')
    await plexo.waitForStatus('completed')
  })
})

test.describe('a slow simulated network', () => {
  test.use({ appEnv: { PLEXO_E2E_HEDGE_MS: '300' } })

  test('does not hold the download back: the fast one takes over its blocks', async ({
    plexo,
    dirs
  }) => {
    // The slow network needs 6.4 s for each 64 KB block it is given, and gets two of them.
    const source = await sourceFile(dirs.userData, 4)
    const started = Date.now()
    await plexo.startSimulated(
      {
        sourceFilePath: source.path,
        networks: [
          { kind: 'usb', label: 'slow', speedBytesPerSec: 10_000, faultRatePercent: 0 },
          network('fast')
        ],
        chunkCount: 4,
        connectionsPerNetwork: 2
      },
      source.sha
    )
    await plexo.waitForStatus('completed', 15_000)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
