import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'
import type { Fault, OriginRequest } from './origin'

// L. Racing a slow block. Near the end of a download, a free stream fetches the rest of a block
// whose holder is too slow, and whichever finishes first wins. Every test here also gets the
// automatic checks: the finished file matches the source byte for byte, and nothing is left on disk.

const BLOCKS = 12
const SLOW = 3 // the block whose first request crawls

test.describe('racing a slow block', () => {
  test.use({ appEnv: { PLEXO_E2E_HEDGE_MS: '400' } })

  const inSlowBlock = (range: OriginRequest['range']): boolean =>
    !!range && range.start >= SLOW * BLOCK && range.start < (SLOW + 1) * BLOCK

  /** The origin's answer to the n-th request that lands in the slow block. */
  const answerRequestsInSlowBlock =
    (byOrder: (n: number, request: OriginRequest) => Fault) =>
    (): ((request: OriginRequest) => Fault | undefined) => {
      let seen = 0
      return (request) => (inSlowBlock(request.range) ? byOrder(seen++, request) : undefined)
    }

  test('a block crawling at 2 KB/s is finished by a hedge that picks up where it had got to', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCKS * BLOCK })
    // 64 KB at 2 KB/s would take half a minute. The hedge is quick but not instant, so the slow
    // holder keeps writing over the range the hedge is writing too: the same bytes, so the file
    // still comes out exact.
    origin.setRule(
      answerRequestsInSlowBlock((n) => (n === 0 ? { crawl: 2000 } : { crawl: 100_000 }))()
    )

    const started = Date.now()
    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed', 10_000)
    expect(Date.now() - started).toBeLessThan(10_000)

    const requests = origin.chunkRequests().filter((r) => inSlowBlock(r.range))
    // Twice: a third would mean the hedge's bytes didn't join the block's and it was fetched again.
    expect(requests, 'the slow block was requested by its holder and by one hedge').toHaveLength(2)
    expect(
      requests.some((r) => r.range!.start > SLOW * BLOCK),
      'the hedge began partway into the block, after what the slow one had already got'
    ).toBe(true)
  })

  test('the slow holder can win, and then the hedge is dropped', async ({ plexo, serve }) => {
    const origin = await serve({ size: BLOCKS * BLOCK })
    // The holder is slowish (about 1.6 s for the block); the hedge is slower still.
    origin.setRule(
      answerRequestsInSlowBlock((n) => (n === 0 ? { crawl: 40_000 } : { crawl: 3000 }))()
    )

    await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await plexo.waitForStatus('completed', 10_000)

    const requests = origin.chunkRequests().filter((r) => inSlowBlock(r.range))
    expect(requests.length).toBeGreaterThanOrEqual(2)
    const hedge = requests[requests.length - 1]
    expect(hedge.bytesSent, 'the losing hedge was cut off').toBeLessThan(BLOCK)
  })

  test('paused while racing, then resumed: no half-hedge is left behind', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: BLOCKS * BLOCK })
    origin.setRule(
      answerRequestsInSlowBlock((n) =>
        n === 0 ? { crawl: 2000 } : n === 1 ? { crawl: 2000 } : 'ok'
      )()
    )

    const id = await plexo.start(origin.url(), origin.sha256, { connections: 4 })
    await expect
      .poll(() => origin.chunkRequests().filter((r) => inSlowBlock(r.range)).length, {
        message: 'the hedge started',
        timeout: 8000
      })
      .toBeGreaterThanOrEqual(2)

    await plexo.api.pauseDownload(id)
    const paused = await plexo.waitForStatus('paused')
    expect(paused.chunks.some((chunk) => chunk.hedge)).toBe(false)

    await plexo.api.resumeDownload(id)
    await plexo.waitForStatus('completed', 15_000)
  })

  test('a second network rescues a block the first is crawling through, and is credited for it', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    const origin = await serve({ size: BLOCKS * BLOCK })
    let crawled = false
    // The first network's first request past the opening blocks is the one that crawls.
    origin.setRule(({ from, range }) => {
      if (crawled || from !== '127.0.0.1' || !range || range.start < 2 * BLOCK) return undefined
      crawled = true
      return { crawl: 2000 }
    })

    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 1 })
    const state = await plexo.waitForStatus('completed', 10_000)

    const shared = (state.blocks ?? []).filter(
      (block) => (block.bytesByInterface['a'] ?? 0) > 0 && (block.bytesByInterface['b'] ?? 0) > 0
    )
    expect(shared.length, 'one block was split between the networks').toBeGreaterThanOrEqual(1)
  })
})
