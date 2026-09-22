import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BLOCK, expect, interfacesEnv, NETWORKS, test } from './fixtures'

// G. A handful of journeys through the real UI, to prove the screens are wired to the main
// process. Download correctness is covered far more thoroughly by the API-level specs; these
// only need to show that clicking the buttons drives it.

const SIZE = 24 * BLOCK

/** The destination picker and "Reveal in Finder" go through native OS UI — replace both. */
async function stubNativeUi(
  plexo: import('./fixtures').PlexoApp,
  destination: string
): Promise<void> {
  await plexo.evaluateMain(({ dialog, shell }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    const revealed: string[] = []
    ;(globalThis as Record<string, unknown>).__revealed = revealed
    shell.showItemInFolder = (path: string) => void revealed.push(path)
  }, destination)
}

test.describe('UI journeys @smoke', () => {
  test('paste a link, start, pause, resume, finish, reveal the file', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(plexo, dirs.dest)
    const page = plexo.page

    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('textbox', { name: 'LINK' }).fill(origin.url())
    const start = page.getByRole('button', { name: 'Start' })
    await expect(start).toBeEnabled()

    const reached = origin.hold(6 * BLOCK)
    await plexo.expectNextDownload(origin.sha256)
    await start.click()
    await reached

    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
    origin.release()
    await page.getByRole('button', { name: 'Resume' }).click()

    const reveal = page.getByRole('button', { name: /Reveal in Finder|Show in folder/ })
    await expect(reveal).toBeVisible()
    await reveal.click()
    const { destinationPath } = (await plexo.current())!
    await expect
      .poll(() =>
        plexo.evaluateMain(() => (globalThis as Record<string, unknown>).__revealed, null)
      )
      .toEqual([destinationPath])
  })

  test('cancel through the confirmation dialog, then "Download Again"', async ({
    plexo,
    serve,
    dirs
  }) => {
    const origin = await serve({ size: SIZE })
    await stubNativeUi(plexo, dirs.dest)
    const page = plexo.page
    await page.getByRole('button', { name: 'Browse…' }).click()
    await page.getByRole('textbox', { name: 'LINK' }).fill(origin.url())

    const reached = origin.hold(6 * BLOCK)
    await page.getByRole('button', { name: 'Start' }).click()
    await reached
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('button', { name: 'Cancel download' }).click()
    origin.release()

    await page.getByRole('button', { name: 'Download Again' }).click()
    await plexo.expectNextDownload(origin.sha256)
    await page.getByRole('button', { name: 'Start' }).click({ timeout: 5000 })
    await expect(
      page.getByRole('button', { name: /Reveal in Finder|Show in folder/ })
    ).toBeVisible()
  })

  test('a link the server rejects shows the error and keeps Start disabled', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: SIZE })
    origin.setRule(() => ({ status: 404 }))
    const page = plexo.page
    await page.getByRole('textbox', { name: 'LINK' }).fill(origin.url())
    await expect(page.getByText(/could not be found/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Start' })).toBeDisabled()
  })

  test('a completed download is shown again after a restart', async ({ plexo, serve }) => {
    const origin = await serve({ size: SIZE })
    await plexo.start(origin.url(), origin.sha256)
    await plexo.waitForStatus('completed')
    await plexo.relaunch()
    await expect(
      plexo.page.getByRole('button', { name: /Reveal in Finder|Show in folder/ })
    ).toBeVisible()
  })

  test('theme choice survives a restart', async ({ plexo }) => {
    const before = await plexo.api.getThemeSource()
    const next = before === 'light' ? 'dark' : 'light'
    await plexo.page.getByRole('button', { name: `Switch to ${next} theme` }).click()
    await expect.poll(() => plexo.api.getThemeSource()).toBe(next)
    await plexo.relaunch()
    expect(await plexo.api.getThemeSource()).toBe(next)
  })

  test('renaming a network survives a restart', async ({ plexo }) => {
    const page = plexo.page
    await page.getByRole('button', { name: 'Edit network' }).first().click()
    await page.getByRole('textbox', { name: 'Name' }).fill('Office fibre')
    await page.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText('Office fibre')).toBeVisible()

    await plexo.relaunch()
    await expect(plexo.page.getByText('Office fibre')).toBeVisible()
  })

  test('a corrupt network-preferences.json does not break the network list', async ({
    plexo,
    dirs
  }) => {
    await plexo.quit()
    await writeFile(join(dirs.userData, 'network-preferences.json'), '{"a": 42, "b": [')
    await plexo.launch()
    await expect(plexo.page.getByRole('button', { name: 'Edit network' }).first()).toBeVisible()
  })
})

test.describe('no networks', () => {
  test.use({ appEnv: { PLEXO_E2E_INTERFACES: '' } })

  test('shows the no-connections screen, and settles on it @smoke', async ({ plexo }) => {
    await plexo.evaluateMain(({ ipcMain }) => {
      const g = globalThis as unknown as Record<string, number>
      g.__scans = 0
      ipcMain.removeHandler('network:list-interfaces')
      ipcMain.handle('network:list-interfaces', () => {
        g.__scans++
        return []
      })
    }, null)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const scans = await plexo.evaluateMain(
      () => (globalThis as unknown as Record<string, number>).__scans,
      null
    )
    // The screen polls every 5 s; a couple of scans in 2 s is normal, thousands is the loop.
    expect(scans).toBeLessThan(10)
    await expect(plexo.page.getByText('No networks to combine')).toBeVisible({ timeout: 5000 })
  })

  test('a network appearing takes you back to the start screen @smoke', async ({ plexo }) => {
    await expect(plexo.page.getByText('No networks to combine')).toBeVisible()
    await plexo.evaluateMain(
      (_electron, value) => {
        process.env['PLEXO_E2E_INTERFACES'] = value
      },
      interfacesEnv({ a: NETWORKS['a'] })
    )
    await plexo.page.getByRole('button', { name: 'Scan Again' }).click()
    await expect(plexo.page.getByRole('textbox', { name: 'LINK' })).toBeVisible()
  })
})
