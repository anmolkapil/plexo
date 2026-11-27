import { expect, test } from './fixtures'

test.describe('titlebar window controls @smoke', () => {
  test('reports window maximize state and shows Windows caption controls only on win32', async ({
    plexo
  }) => {
    const maximized = await plexo.api.windowIsMaximized()
    expect(typeof maximized).toBe('boolean')

    const minimize = plexo.page.getByRole('button', { name: 'Minimize', exact: true })
    const close = plexo.page.getByRole('button', { name: 'Close', exact: true })

    if (process.platform === 'win32') {
      await expect(minimize).toBeVisible()
      await expect(close).toBeVisible()
      await expect(minimize).not.toHaveAttribute('title', /.*/)
      await expect(close).not.toHaveAttribute('title', /.*/)

      await close.hover()
      const tooltip = plexo.page.getByRole('tooltip')
      await expect(tooltip).toHaveCount(1)
      await expect(tooltip).toHaveText('Close')

      const maximize = plexo.page.getByRole('button', { name: 'Maximize', exact: true })
      await expect(maximize).toBeVisible()
      await maximize.click()
      await expect(plexo.page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    } else {
      await expect(minimize).toHaveCount(0)
      await expect(close).toHaveCount(0)
    }
  })
})
