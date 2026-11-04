import type { TelegramMediaType } from '../src/shared/types'
import { expect, test, type PlexoApp } from './fixtures'

// Downloading from Telegram: the service is the e2e double (PLEXO_E2E_TELEGRAM_FAKE=1), so
// the real transfer, manager, queue and persistence run against a source that serves seeded
// bytes and inflicts the DC's faults — a flood-wait, a stale file reference, per-region caps
// on the request size, and a photo whose size only the download itself learns.

const KB = 1024

test.use({
  appEnv: {
    PLEXO_E2E_TELEGRAM_FAKE: '1',
    // 500ms a chunk: a 3 MiB file takes ~3s, leaving a solid window to pause it mid-flight.
    PLEXO_E2E_TELEGRAM_DELAY_MS: '500'
  }
})

async function startItem(
  plexo: PlexoApp,
  messageId: number,
  mediaType: TelegramMediaType,
  fileName: string,
  totalBytes: number
): Promise<string> {
  return plexo.api.startDownload({
    kind: 'telegram',
    messageId,
    mediaType,
    url: `telegram://saved-messages/${messageId}`,
    destinationDir: plexo.dirs.dest,
    suggestedFileName: fileName,
    totalBytes,
    supportsRanges: true,
    interfaceIds: (await plexo.api.listInterfaces()).map((iface) => iface.id),
    etag: null,
    lastModified: null
  })
}

test.describe('Telegram Saved Messages downloads', () => {
  test('signs in through the dialog, lists media, and downloads a video and a photo @smoke', async ({
    plexo
  }) => {
    await plexo.page.getByRole('button', { name: 'Telegram' }).first().click()
    await plexo.page.locator('#tg-api-id').fill('12345')
    await plexo.page.locator('#tg-api-hash').fill('fake-hash')
    await plexo.page.locator('#tg-phone').fill('+1 555 010 1234')
    await plexo.page.getByRole('button', { name: 'Send code' }).click()

    // Signed in: the media browser is there, the login form isn't.
    const list = plexo.page.getByRole('group', { name: 'Saved Messages media' })
    await list.waitFor()
    await expect(plexo.page.locator('#tg-api-id')).toHaveCount(0)
    await expect(list).toContainText('clip.mp4')
    await expect(list).toContainText('shot.jpg')

    await plexo.page.getByText('clip.mp4').click()
    await plexo.page.getByText('shot.jpg').click()
    await plexo.page.getByRole('button', { name: /Download 2/ }).click()

    await expect
      .poll(async () => (await plexo.all()).filter((state) => state.status === 'completed').length, {
        timeout: 30_000
      })
      .toBe(2)
    const finished = (await plexo.all()).filter((state) => state.status === 'completed')
    // The video's size was known ahead; the photo's size only the download itself learned.
    // (Completion order and name suffixes aren't: whichever finished first sorts first.)
    const video = finished.find((state) => state.fileName.startsWith('clip'))
    const photo = finished.find((state) => state.fileName.startsWith('shot'))
    expect(video?.totalBytes).toBe(3 * KB * KB)
    expect(photo?.totalBytes).toBe(2 * KB * KB)
  })

  test('a flaky file survives a flood-wait, a stale file reference and region caps', async ({
    plexo
  }) => {
    const id = await startItem(plexo, 3, 'document', 'flaky.zip', 3 * KB * KB)
    const done = await plexo.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
    expect(done.totalBytes).toBe(3 * KB * KB)
  })

  test('a paused download resumes after a relaunch', async ({ plexo }) => {
    const id = await startItem(plexo, 1, 'video', 'clip.mp4', 3 * KB * KB)
    // Pause straight away: the chunks take 500ms each, so this lands mid-download.
    await plexo.api.pauseDownload(id)
    const paused = await plexo.waitForStatus('paused', 15_000)
    expect(paused.id).toBe(id)

    await plexo.relaunch()
    const restored = (await plexo.all()).find((state) => state.id === id)
    expect(restored?.status).toBe('paused')

    await plexo.api.resumeDownload(id)
    const done = await plexo.waitForStatus('completed', 30_000)
    expect(done.id).toBe(id)
  })
})
