import type { Locator } from '@playwright/test'
import { BLOCK, expect, LAN_ADDRESS, test, type PlexoApp } from './fixtures'

// The downloading screen's combine diagram, through the real UI: each network's path drawn by
// its share of the total, and the moment a network joins or drops out marked beside the total
// speed. Its arithmetic is in combineFlow.spec.ts.

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A network's path into the combine node. */
const pathOf = (plexo: PlexoApp, id: string): Locator =>
  plexo.page.locator(`svg path[data-network="${id}"]`)

const shareOf = async (path: Locator): Promise<number> =>
  Number(await path.getAttribute('data-share'))

test.describe('combine diagram @smoke', () => {
  test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')

  test('paths show each network’s share; a network switched on is marked once, and still once off', async ({
    plexo,
    serve
  }) => {
    // Long enough to outlast a join, a drop and their few seconds each: about 1 MB/s over both.
    const origin = await serve({ size: 384 * BLOCK, bytesPerSecond: 256 * 1024 })
    const id = await plexo.start(origin.url(), origin.sha256, { networks: ['a'], connections: 2 })
    await plexo.waitUntil((state) => state.bytesDownloaded > 0)
    const page = plexo.page
    await page.getByRole('button', { name: 'Open test.bin', exact: true }).click()

    // Alone, a carries all of it: its path at the top step. b is listed, switched off, and so
    // not in the diagram at all.
    await expect(pathOf(plexo, 'a')).toHaveAttribute('data-flow-step', '4')
    await expect(pathOf(plexo, 'a')).toHaveAttribute('data-share', '100')
    await expect(pathOf(plexo, 'b')).toHaveCount(0)

    // Every "+…" or "−…" that turns up from here, however briefly: whether it shows once can't be
    // told from polling for it.
    await page.evaluate(() => {
      const seen: string[] = []
      ;(window as unknown as { __speedChanges: string[] }).__speedChanges = seen
      new MutationObserver((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if (!(node instanceof Element)) continue
            const change = node.matches('[data-testid="speed-change"]')
              ? node
              : node.querySelector('[data-testid="speed-change"]')
            if (change) seen.push(change.textContent ?? '')
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
    const seen = (): Promise<string[]> =>
      page.evaluate(() => (window as unknown as { __speedChanges: string[] }).__speedChanges)

    // a has carried the download on its own for a while (longer than the 2.5 s a network takes
    // to count as carrying it, with room for a busy machine): b switched on now joins it.
    await settle(4500)
    expect(await seen(), 'nothing marked while a carried it alone').toEqual([])
    await plexo.api.setDownloadNetwork(id, 'b', true)

    const change = page.getByTestId('speed-change')
    await expect(change).toHaveText(/joined: \+\d[\d.]* (KB\/s|MB\/s|Kbps|Mbps)$/, {
      timeout: 8000
    })
    await expect(page.getByTestId('combine-draw-in')).toHaveCount(1)
    // Both carry part of it now, and their parts make up the whole.
    await expect(pathOf(plexo, 'b')).toHaveAttribute('data-flow-step', /^[1-4]$/)
    await expect
      .poll(async () => {
        const [a, b] = [await shareOf(pathOf(plexo, 'a')), await shareOf(pathOf(plexo, 'b'))]
        return a > 0 && b > 0 && Math.abs(a + b - 100) <= 1
      })
      .toBe(true)

    // Shown for a moment, then gone; and not again while both keep going.
    await expect(change).toBeHidden({ timeout: 4000 })
    await settle(2000)
    expect(await seen()).toHaveLength(1)
    expect((await seen())[0]).toMatch(/\+/)

    // Switched off, b's path stops moving and the total says what it took away.
    await plexo.api.setDownloadNetwork(id, 'b', false)
    await expect(pathOf(plexo, 'b')).toHaveAttribute('data-flow-step', '0')
    await expect
      .poll(() => pathOf(plexo, 'b').evaluate((path) => getComputedStyle(path).animationName))
      .toBe('none')
    await expect(change).toHaveText(/dropped out: −\d[\d.]* (KB\/s|MB\/s|Kbps|Mbps)$/, {
      timeout: 8000
    })
    expect(await seen()).toHaveLength(2)
    await expect(pathOf(plexo, 'a')).toHaveAttribute('data-flow-step', '4')
  })
})
