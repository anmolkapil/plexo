import { BLOCK, expect, test } from './fixtures'
import type { Origin } from './origin'

/** Which of these downloads gets its first bytes first: each origin stops just past its start. */
function firstToStart(origins: Record<string, Origin>): Promise<string> {
  return Promise.race(
    Object.entries(origins).map(([name, origin]) => origin.hold(4 * BLOCK).then(() => name))
  )
}

test('Move up and Move down change which queued download starts next', async ({ plexo, serve }) => {
  await plexo.api.updateSettings({ downloadsAtOnce: 1 })
  const [first, second, third] = await Promise.all([0, 1, 2].map(() => serve({ size: 24 * BLOCK })))
  const running = first.hold(4 * BLOCK)
  const firstId = await plexo.start(first.url(), first.sha256, { fileName: 'first.bin' })
  await running
  const secondId = await plexo.start(second.url(), second.sha256, { fileName: 'second.bin' })
  const thirdId = await plexo.start(third.url(), third.sha256, { fileName: 'third.bin' })

  const page = plexo.page
  const queued = page.getByRole('checkbox', { name: /^Select (second|third)\.bin$/ })
  await expect(queued.first()).toHaveAccessibleName('Select second.bin')
  const menu = async (name: string, item: string): Promise<void> => {
    await page.getByRole('button', { name: `Open ${name}`, exact: true }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: item, exact: true }).click()
  }

  // Up, then down again: back where they were.
  await menu('third.bin', 'Move up')
  await expect(queued.first()).toHaveAccessibleName('Select third.bin')
  await menu('third.bin', 'Move down')
  await expect(queued.first()).toHaveAccessibleName('Select second.bin')
  // At the end of the queue there's nowhere to go: the order holds.
  await menu('third.bin', 'Move down')
  await menu('second.bin', 'Move up')
  await expect(queued.first()).toHaveAccessibleName('Select second.bin')

  // Move the second down: the third starts when the first is done. Nothing running is paused.
  await menu('second.bin', 'Move down')
  await expect(queued.first()).toHaveAccessibleName('Select third.bin')
  expect((await plexo.byId(firstId))?.status).toBe('downloading')

  const started = firstToStart({ second, third })
  first.release()
  expect(await started).toBe('third')
  expect((await plexo.byId(secondId))?.status).toBe('queued')
  third.release()
  second.release()
  for (const id of [firstId, secondId, thirdId])
    await expect.poll(async () => (await plexo.byId(id))?.status).toBe('completed')
})
