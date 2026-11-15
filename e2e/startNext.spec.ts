import { BLOCK, expect, test } from './fixtures'
import type { Origin } from './origin'

/** Which of these downloads gets its first bytes first: each origin stops just past its start. */
function firstToStart(origins: Record<string, Origin>): Promise<string> {
  return Promise.race(
    Object.entries(origins).map(([name, origin]) => origin.hold(4 * BLOCK).then(() => name))
  )
}

test('Start next on the last queued download makes it the second to start', async ({
  plexo,
  serve
}) => {
  await plexo.api.updateSettings({ downloadsAtOnce: 1 })
  const [first, second, third] = await Promise.all([0, 1, 2].map(() => serve({ size: 24 * BLOCK })))
  const running = first.hold(4 * BLOCK)
  const firstId = await plexo.start(first.url(), first.sha256, { fileName: 'first.bin' })
  await running
  const secondId = await plexo.start(second.url(), second.sha256, { fileName: 'second.bin' })
  const thirdId = await plexo.start(third.url(), third.sha256, { fileName: 'third.bin' })
  expect((await plexo.byId(secondId))?.status).toBe('queued')
  expect((await plexo.byId(thirdId))?.status).toBe('queued')

  const page = plexo.page
  const queued = page.getByRole('checkbox', { name: /^Select (second|third)\.bin$/ })
  await expect(queued.first()).toHaveAccessibleName('Select second.bin')
  await page.getByRole('button', { name: 'Open third.bin', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Start next', exact: true }).click()
  // The list shows the new order, and the one running carries on: nothing paused for it.
  await expect(queued.first()).toHaveAccessibleName('Select third.bin')
  expect((await plexo.byId(firstId))?.status).toBe('downloading')
  expect((await plexo.byId(thirdId))?.status).toBe('queued')

  const started = firstToStart({ second, third })
  first.release()
  expect(await started).toBe('third')
  // One at a time still: the second waits for the third.
  expect((await plexo.byId(secondId))?.status).toBe('queued')
  third.release()
  second.release()
  for (const id of [firstId, secondId, thirdId])
    await expect.poll(async () => (await plexo.byId(id))?.status).toBe('completed')
})
