import { expect, test } from './fixtures'

test.use({
  appEnv: {
    PLEXO_E2E_BLOCK_BYTES: String(1024 * 1024),
    PLEXO_E2E_HEDGE_MS: '100',
    PLEXO_E2E_SLOW_WARMUP_MS: '100',
    PLEXO_E2E_SLOW_FOR_MS: '100'
  }
})

test('a slow write flush is not reconnected or fetched again as a slow network', async ({
  plexo,
  serve
}) => {
  await plexo.evaluateMain(async () => {
    const fs = process.getBuiltinModule('node:fs/promises') as typeof import('node:fs/promises')
    const os = process.getBuiltinModule('node:os') as typeof import('node:os')
    const path = process.getBuiltinModule('node:path') as typeof import('node:path')
    const probe = path.join(os.tmpdir(), `plexo-flush-probe-${process.pid}`)
    const handle = await fs.open(probe, 'w')
    const prototype = Object.getPrototypeOf(handle)
    const writev = prototype.writev
    let first = true
    prototype.writev = async function (...args: unknown[]) {
      const result = await writev.apply(this, args)
      if (first) {
        first = false
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
      return result
    }
    await handle.close()
    await fs.unlink(probe)
  }, null)
  const origin = await serve({ size: 4 * 1024 * 1024 })
  await plexo.start(origin.url(), origin.sha256, { connections: 'auto' })
  await plexo.waitForHttpStatus('completed', 20_000)
  const ranges = origin.log.filter(
    (request) => request.range && !(request.range.start === 0 && request.range.end === 0)
  )
  expect(ranges).toHaveLength(4)
  expect(ranges.every((request) => request.bytesSent === 1024 * 1024)).toBe(true)
  // The fixture also verifies the published file hash.
})
