import { expect, test } from './fixtures'

const BLOCK = 1024 * 1024

test.use({
  appEnv: {
    PLEXO_E2E_BLOCK_BYTES: String(BLOCK),
    PLEXO_E2E_HEDGE_MS: '2000',
    PLEXO_E2E_SLOW_WARMUP_MS: '5000',
    PLEXO_E2E_SLOW_FOR_MS: '10000'
  }
})

test('a disk-held range is not fetched again while other streams finish @smoke', async ({
  plexo,
  serve
}) => {
  // The first write to reach the disk takes 3 s. Writes are gathered (see chunkDownloader.ts),
  // so it can go down on its own or together with others: either way it is held. Its writer
  // fills and its reader stops long before the other streams have finished their blocks.
  await plexo.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    type Write = (this: { start: number }, ...args: unknown[]) => void
    const prototype = fs.WriteStream.prototype as unknown as Record<'_write' | '_writev', Write>
    const seen = globalThis as unknown as { heldWriterStart?: number }
    let first = true
    for (const name of ['_write', '_writev'] as const) {
      const original = prototype[name]
      prototype[name] = function (...args) {
        const hold = first
        first = false
        if (hold) seen.heldWriterStart = this.start
        const callback = args.pop() as (error?: Error | null) => void
        original.call(this, ...args, (error?: Error | null) => {
          if (hold) setTimeout(() => callback(error), 3000)
          else callback(error)
        })
      }
    }
  }, null)
  const origin = await serve({ size: 4 * BLOCK })
  await plexo.start(origin.url(), origin.sha256, { connections: 4 })
  await plexo.waitForHttpStatus('completed', 15000)

  const heldWriterStart = await plexo.evaluateMain(
    () => (globalThis as unknown as { heldWriterStart?: number }).heldWriterStart,
    null
  )
  expect(heldWriterStart, 'no write was held').toBeDefined()
  const heldStart = Math.floor(heldWriterStart! / BLOCK) * BLOCK
  const heldEnd = heldStart + BLOCK - 1
  // The held block's whole range was on its way to its holder, which only had to wait for the
  // disk: it is asked for once. A block that is just slow can still be shared out at the end.
  const asked = origin
    .chunkRequests()
    .filter(({ range }) => range && range.start <= heldEnd && (range.end ?? Infinity) >= heldStart)
  expect(asked.map(({ range }) => range)).toEqual([{ start: heldStart, end: heldEnd }])
})
