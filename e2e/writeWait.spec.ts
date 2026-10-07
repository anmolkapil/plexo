import { expect, test } from './fixtures'

test.use({
  appEnv: {
    PLEXO_E2E_BLOCK_BYTES: String(1024 * 1024),
    PLEXO_E2E_HEDGE_MS: '2000',
    PLEXO_E2E_SLOW_WARMUP_MS: '5000',
    PLEXO_E2E_SLOW_FOR_MS: '10000'
  }
})

test('a disk-held range is not fetched again while other streams finish @smoke', async ({
  plexo,
  serve
}) => {
  await plexo.evaluateMain(() => {
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    const prototype = fs.WriteStream.prototype as unknown as {
      _write: (chunk: Buffer, encoding: string, callback: (error?: Error | null) => void) => void
    }
    const original = prototype._write
    let first = true
    prototype._write = function (chunk, encoding, callback) {
      const hold = first
      first = false
      original.call(this, chunk, encoding, (error) => {
        if (hold) setTimeout(() => callback(error), 3000)
        else callback(error)
      })
    }
  }, null)
  const origin = await serve({ size: 4 * 1024 * 1024 })
  await plexo.start(origin.url(), origin.sha256, { connections: 4 })
  await plexo.waitForHttpStatus('completed', 15000)
  const ranges = origin.chunkRequests()
  expect(ranges).toHaveLength(4)
})
