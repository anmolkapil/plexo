import { test, expect, BLOCK } from './fixtures'

test.describe('probe redirect limits @smoke', () => {
  for (const count of [0, 5]) {
    test(`${count} redirects reach the real file metadata`, async ({ plexo, serve }) => {
      const origin = await serve({ size: 3 * BLOCK })
      origin.setRule(({ path }) => {
        const remaining = Number(/^\/hop\/(\d+)$/.exec(path)?.[1] ?? 0)
        return remaining > 0 ? { redirect: `/hop/${remaining - 1}` } : 'ok'
      })
      const result = await plexo.api.probeUrl(origin.url(`/hop/${count}`))
      expect(result.kind).toBe('http')
      if (result.kind !== 'http') throw new Error('Expected HTTP probe')
      expect(result.finalUrl).toBe(origin.url('/hop/0'))
      expect(result.totalBytes).toBe(3 * BLOCK)
      expect(result.supportsRanges).toBe(true)
    })
  }

  for (const path of ['/hop/6', '/loop']) {
    test(`${path} rejects redirect exhaustion before offering a download`, async ({
      plexo,
      serve
    }) => {
      const origin = await serve({ size: 3 * BLOCK })
      origin.setRule(({ path: requestPath }) => {
        if (requestPath === '/loop') return { redirect: '/loop' }
        const remaining = Number(/^\/hop\/(\d+)$/.exec(requestPath)?.[1] ?? 0)
        return remaining > 0 ? { redirect: `/hop/${remaining - 1}` } : 'ok'
      })
      await expect(plexo.api.probeUrl(origin.url(path))).rejects.toThrow(/Too many redirects/)
    })
  }
})
