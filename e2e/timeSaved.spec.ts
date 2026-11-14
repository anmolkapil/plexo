import { expect as plainExpect, test as plain } from '@playwright/test'
import {
  describeTimeSaved,
  downloadingSeconds,
  estimateTimeSaved,
  timeSavedOf
} from '../src/shared/timeSaved'
import type { HttpDownloadNetwork } from '../src/shared/types'
import { BLOCK, expect, LAN_ADDRESS, test } from './fixtures'

const MB = 1024 ** 2

function network(id: string, bytes: number, activeSeconds?: number): HttpDownloadNetwork {
  return {
    transfer: 'http',
    id,
    label: id,
    kind: 'ethernet',
    enabled: true,
    status: 'on',
    bytesDownloaded: bytes,
    activeMs: activeSeconds === undefined ? undefined : activeSeconds * 1000,
    speedBytesPerSec: 0,
    retries: 0
  }
}

plain.describe('time saved, worked out @smoke', () => {
  plain('against the fastest network alone, by what it did while it took part', () => {
    // Wi-Fi did 60 MB in the 60 s it ran (1 MB/s), USB 40 MB in the same time: 100 MB alone at
    // 1 MB/s is 100 s, 40 s more than it took.
    const saved = estimateTimeSaved(60, [network('wifi', 60 * MB, 60), network('usb', 40 * MB, 60)])
    plainExpect(saved?.network.id).toBe('wifi')
    plainExpect(saved?.seconds).toBeCloseTo(40)
  })

  plain('a network that joined late is read over its own time, not the download’s', () => {
    // USB ran only the last 20 s, at 1 MB/s; Wi-Fi did 80 MB in 60 s. Alone, Wi-Fi's 1.33 MB/s
    // takes 75 s for the 100 MB.
    const saved = estimateTimeSaved(60, [network('wifi', 80 * MB, 60), network('usb', 20 * MB, 20)])
    plainExpect(saved?.network.id).toBe('wifi')
    plainExpect(saved?.seconds).toBeCloseTo(15)
    // Read over the whole minute, USB would have seemed slower than it was. Here it's the faster
    // one (2 MB/s over its 20 s): alone it takes 50 s, sooner than it did. Nothing to say.
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 60 * MB, 60), network('usb', 40 * MB, 20)])
    ).toBeNull()
  })

  plain('one network, or another with only a sliver of the bytes: no saving', () => {
    plainExpect(estimateTimeSaved(60, [network('wifi', 100 * MB, 60)])).toBeNull()
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 100 * MB, 60), network('usb', 0, 0)])
    ).toBeNull()
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 97 * MB, 60), network('usb', 3 * MB, 60)])
    ).toBeNull()
    plainExpect(estimateTimeSaved(60, [])).toBeNull()
  })

  plain('too short, no time at all, or not a number: no saving', () => {
    const networks = [network('wifi', 5 * MB, 5), network('usb', 5 * MB, 5)]
    plainExpect(estimateTimeSaved(5, networks)).toBeNull()
    plainExpect(estimateTimeSaved(0, networks)).toBeNull()
    plainExpect(estimateTimeSaved(Number.NaN, networks)).toBeNull()
  })

  plain('a saving of a second or two, or a few percent, isn’t worth a line', () => {
    // Alone: 13 s against 12 taken.
    plainExpect(
      estimateTimeSaved(12, [network('wifi', 12 * MB, 12), network('usb', 1 * MB, 12)])
    ).toBeNull()
    // Alone: 2 h 5 min against 2 h — 5 min, but 4%.
    const hours = 2 * 3600
    plainExpect(
      estimateTimeSaved(hours, [network('wifi', 6900 * MB, 6900), network('usb', 600 * MB, hours)])
    ).toBeNull()
  })

  plain('a network without its active time (a download from before) says nothing', () => {
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 60 * MB), network('usb', 40 * MB, 60)])
    ).toBeNull()
    // Or one that isn't a number, from a hand-edited history.
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 60 * MB, 60), network('usb', 40 * MB, Number.NaN)])
    ).toBeNull()
  })

  plain('active time is held to at least a second and at most the download', () => {
    // A burst in one tick isn't a speed: read over a second, 50 MB/s, 3 s alone, slower than it
    // took — so nothing, rather than a saving off a speed it never had.
    plainExpect(
      estimateTimeSaved(60, [network('wifi', 50 * MB, 0.1), network('usb', 50 * MB, 60)])
    ).toBeNull()
    // More active time than the download had is the download's.
    const saved = estimateTimeSaved(60, [
      network('wifi', 60 * MB, 600),
      network('usb', 40 * MB, 60)
    ])
    plainExpect(saved?.seconds).toBeCloseTo(40)
  })

  plain('Telegram’s networks are no reading of their speed', () => {
    const networks = [network('wifi', 60 * MB, 60), network('usb', 40 * MB, 60)]
    const finished = { networks, startedAt: 0, completedAt: 60_000, totalPausedMs: 0 }
    plainExpect(timeSavedOf({ ...finished, kind: 'http' })?.seconds).toBeCloseTo(40)
    plainExpect(timeSavedOf({ ...finished, kind: 'torrent' })?.seconds).toBeCloseTo(40)
    plainExpect(timeSavedOf({ ...finished, kind: 'telegram' })).toBeNull()
  })

  plain('the time it took leaves pauses out', () => {
    plainExpect(
      downloadingSeconds({ startedAt: 1000, completedAt: 71_000, totalPausedMs: 10_000 })
    ).toBe(60)
    plainExpect(downloadingSeconds({ startedAt: 1000 })).toBe(0)
  })

  plain('said as roughly as an estimate deserves', () => {
    plainExpect(describeTimeSaved(5.2, 'Wi-Fi')).toBe('about 5 sec sooner than Wi-Fi alone')
    plainExpect(describeTimeSaved(13, 'Wi-Fi')).toBe('about 15 sec sooner than Wi-Fi alone')
    plainExpect(describeTimeSaved(58, 'Wi-Fi')).toBe('about 1 min sooner than Wi-Fi alone')
    plainExpect(describeTimeSaved(4 * 60 + 20, 'iPhone USB')).toBe(
      'about 4 min sooner than iPhone USB alone'
    )
    plainExpect(describeTimeSaved(3600, 'Wi-Fi')).toBe('about 1 hr sooner than Wi-Fi alone')
    plainExpect(describeTimeSaved(3600 + 25 * 60, 'Wi-Fi')).toBe(
      'about 1 hr 25 min sooner than Wi-Fi alone'
    )
  })
})

test.describe('time saved, on the Complete screen', () => {
  test('two networks: each one’s share, and how much sooner it came — after a restart too', async ({
    plexo,
    serve
  }) => {
    test.skip(!LAN_ADDRESS, 'needs a LAN address to act as the second network')
    // Every response at the same speed: each network on its own does half what both do together,
    // so the file comes in about twice as fast as either alone. Long enough (about 14 s) for a
    // saving to be read at all.
    const origin = await serve({ size: 56 * BLOCK, bytesPerSecond: 48 * 1024 })
    await plexo.start(origin.url(), origin.sha256, { networks: ['a', 'b'], connections: 2 })
    const { fileName } = await plexo.waitForHttpStatus('completed')

    const check = async (): Promise<void> => {
      const page = plexo.page
      await page.getByRole('button', { name: `Open ${fileName}` }).click()
      await expect(page.getByRole('img', { name: /^a \d+%, b \d+%$/ })).toBeVisible()
      await expect(page.getByText(/^About \d+ (sec|min) sooner than [ab] alone$/)).toBeVisible()
    }
    await check()
    // From history, as it was kept.
    await plexo.relaunch()
    await check()
  })

  test('one network: its share, and no saving', async ({ plexo, serve }) => {
    const origin = await serve({ size: 16 * BLOCK })
    await plexo.start(origin.url(), origin.sha256, { networks: ['a'] })
    const { fileName } = await plexo.waitForHttpStatus('completed')
    const page = plexo.page
    await page.getByRole('button', { name: `Open ${fileName}` }).click()
    await expect(page.getByRole('img', { name: 'a 100%' })).toBeVisible()
    await expect(page.getByText('Contribution by network')).toBeVisible()
    await expect(page.getByText(/sooner than/)).toHaveCount(0)
  })
})
