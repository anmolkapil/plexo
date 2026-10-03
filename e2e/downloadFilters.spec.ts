import { BLOCK, expect, test } from './fixtures'

test('download filters show live counts, retain the filter, and clear hidden selections', async ({
  plexo,
  serve
}) => {
  const finished = await serve({ size: BLOCK })
  await plexo.start(finished.url(), finished.sha256, { fileName: 'finished.bin' })
  await plexo.waitForStatus('completed')

  const failed = await serve({ size: 16 * BLOCK })
  const reached = failed.hold(4 * BLOCK)
  const failedId = await plexo.start(failed.url(), failed.sha256, { fileName: 'failed.bin' })
  await reached
  failed.setRule(() => ({ status: 403 }))
  failed.release()
  await plexo.waitForStatus('error', 30_000)

  const paused = await serve({ size: 16 * BLOCK })
  const pausedReached = paused.hold(4 * BLOCK)
  const pausedId = await plexo.start(paused.url(), paused.sha256, { fileName: 'paused.bin' })
  await pausedReached
  await plexo.api.pauseDownload(pausedId)
  paused.release()
  await plexo.waitForStatus('paused')

  const page = plexo.page
  const trigger = page.getByRole('heading', { level: 1 }).getByRole('button')
  await trigger.click()
  for (const [label, count] of [
    ['All downloads', 3],
    ['In progress', 1],
    ['Finished', 1],
    ['Needs attention', 1]
  ] as const) {
    await expect(
      page.getByRole('menuitemradio', { name: `${label} ${count}`, exact: true })
    ).toBeVisible()
  }
  await page.getByRole('menuitemradio', { name: 'In progress 1', exact: true }).click()
  await expect(trigger).toHaveText('In progress')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open paused.bin', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open finished.bin', exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open failed.bin', exact: true })).toBeHidden()

  await page.getByRole('button', { name: 'Open paused.bin', exact: true }).click()
  await page.getByRole('button', { name: 'Downloads', exact: true }).click()
  await expect(trigger).toHaveText('In progress')
  await page.getByRole('checkbox', { name: 'Select paused.bin', exact: true }).check()
  await expect(trigger).toBeHidden()
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click()
  await trigger.click()
  await page.getByRole('menuitemradio', { name: 'Finished 1', exact: true }).click()
  await expect(page.getByText('1 selected', { exact: true })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open finished.bin', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open paused.bin', exact: true })).toBeHidden()

  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(trigger).toBeFocused()

  await trigger.click()
  await page.getByRole('menuitemradio', { name: 'Needs attention 1', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open failed.bin', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Fix link', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Fix link', exact: true }).click()
  const fixLink = page.getByRole('dialog', { name: 'Paste a new link', exact: true })
  await expect(fixLink.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0)
  await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 5, y: 5 } })
  await expect(fixLink).toBeVisible()
  await fixLink.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(fixLink).toBeHidden()

  await plexo.api.removeDownload(failedId)
  await expect(page.getByText('No downloads need attention', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Show all downloads', exact: true }).click()
  await expect(trigger).toHaveText('All downloads')
  await trigger.click()
  await expect(
    page.getByRole('menuitemradio', { name: 'All downloads 2', exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole('menuitemradio', { name: 'Needs attention 0', exact: true })
  ).toBeVisible()
})
