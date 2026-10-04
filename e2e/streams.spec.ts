import { BLOCK, expect, test } from './fixtures'
import type { DownloadState } from '../src/shared/types'

// N. How many streams a download runs, decided while it runs (see concurrency.ts), against a
// server that limits it in each of the ways that matter.

test.describe('automatic stream count', () => {
  const peakStreams = (plexo: { sessions: DownloadState[][] }): number =>
    Math.max(
      ...plexo.sessions.at(-1)!.map((state) => (state.kind === 'http' ? state.streams.length : 0))
    )

  test('a server that turns extra connections away keeps the ones it accepted', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 96 * BLOCK, bytesPerSecond: 256 * 1024 })
    const accepted = new Set<number>()
    origin.setRule(({ connection, range }) => {
      if (range?.start === 0 && range.end === 0) return undefined // the probe
      if (accepted.has(connection) || accepted.size < 4) {
        accepted.add(connection)
        return undefined
      }
      return { status: 503 }
    })

    await plexo.start(origin.url(), origin.sha256, { connections: 'auto' })
    const state = await plexo.waitForHttpStatus('completed', 40_000)
    expect(peakStreams(plexo), 'more streams were tried').toBe(8)
    expect(state.streams).toHaveLength(4)
    expect(origin.log.some((request) => request.status === 503)).toBe(true)
  })

  test.describe('left unanswered', () => {
    // As in the app, a request with no answer is noticed as silent before it times out.
    test.use({ appEnv: { PLEXO_E2E_STALL_MS: '20000' } })

    test('a server that leaves extra connections unanswered keeps the ones it answers', async ({
      plexo,
      serve
    }) => {
      const origin = await serve({ size: 256 * BLOCK, bytesPerSecond: 256 * 1024 })
      const accepted = new Set<number>()
      origin.setRule(({ connection, range }) => {
        if (range?.start === 0 && range.end === 0) return undefined // the probe
        if (accepted.has(connection) || accepted.size < 4) {
          accepted.add(connection)
          return undefined
        }
        return 'stallHeaders'
      })

      await plexo.start(origin.url(), origin.sha256, { connections: 'auto' })
      const state = await plexo.waitForHttpStatus('completed', 40_000)
      expect(peakStreams(plexo), 'more streams were tried').toBe(8)
      expect(state.streams).toHaveLength(4)
    })
  })

  test.describe('waited out', () => {
    test.use({ appEnv: { PLEXO_E2E_SERVER_BUSY_MS: '60000' } })

    test('a server busy for everyone at first is waited out, not taken as a connection limit', async ({
      plexo,
      serve
    }) => {
      const origin = await serve({ size: 96 * BLOCK, bytesPerSecond: 256 * 1024 })
      let busyUntil = 0
      origin.setRule(({ range }) => {
        if (range?.start === 0 && range.end === 0) return undefined // the probe
        busyUntil ||= Date.now() + 1500
        return Date.now() < busyUntil ? { status: 503 } : undefined
      })

      await plexo.start(origin.url(), origin.sha256, { connections: 'auto' })
      const state = await plexo.waitForHttpStatus('completed', 40_000)
      expect(origin.log.some((request) => request.status === 503)).toBe(true)
      // Every stream was turned away alike, so none was closed for it, and the count still grew.
      expect(peakStreams(plexo), 'the count grew once the server served').toBeGreaterThan(8)
      expect(state.streams.length).toBeGreaterThan(8)
    })
  })

  test('a count picked on the start screen is kept rather than grown', async ({ plexo, serve }) => {
    const origin = await serve({ size: 96 * BLOCK, bytesPerSecond: 256 * 1024 })
    await plexo.start(origin.url(), origin.sha256, { connections: 'auto', streamsPerNetwork: 4 })
    await plexo.waitForHttpStatus('completed', 40_000)
    expect(peakStreams(plexo), 'Auto would have doubled to 8 and on').toBe(4)
  })
})
