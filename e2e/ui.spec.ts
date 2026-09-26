import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
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
})

// What a user sets is still set after they reload or restart — checked only through what they see.
test.describe('settings @smoke', () => {
  test.describe('with an update available', () => {
    test.use({ appEnv: { PLEXO_FORCE_UPDATE_VERSION: '9.9.9' } })

    test('every choice survives a reload and a restart, even made right before', async ({
      plexo,
      dirs
    }) => {
      const page = (): Page => plexo.page
      await page().getByRole('button', { name: 'Not now' }).click()

      const themeToggle = page().getByRole('button', { name: /^Switch to (dark|light) theme$/ })
      // After switching, the toggle offers to switch back.
      const labelAfterSwitch = (await themeToggle.getAttribute('aria-label'))!.includes('dark')
        ? 'Switch to light theme'
        : 'Switch to dark theme'
      await themeToggle.click()

      await stubNativeUi(plexo, dirs.dest)
      await page().getByRole('button', { name: 'Browse…' }).click()

      await page().getByRole('button', { name: 'Edit network' }).first().click()
      await page().getByRole('textbox', { name: 'Name' }).fill('Office fibre')
      await page().getByRole('button', { name: 'Violet' }).click()
      await page().getByRole('button', { name: 'Done' }).click()

      const expectAllKept = async (): Promise<void> => {
        // Waiting on the titlebar indicator first means the update check has answered, so the
        // dialog's absence below is a real "stayed dismissed", not "not checked yet".
        await expect(page().getByRole('link', { name: 'Update available: 9.9.9' })).toBeVisible()
        await expect(page().getByRole('alertdialog')).toBeHidden()
        await expect(page().getByRole('button', { name: labelAfterSwitch })).toBeVisible()
        await expect(page().getByText(dirs.dest)).toBeVisible()
        await expect(page().getByText('Office fibre')).toBeVisible()
        await page().getByRole('button', { name: 'Edit network' }).first().click()
        await expect(page().getByRole('button', { name: 'Violet' })).toHaveAttribute(
          'aria-pressed',
          'true'
        )
        await page().keyboard.press('Escape')
      }

      // No waiting for saves: a user doesn't either.
      await page().reload()
      await expectAllKept()
      await plexo.relaunch()
      await expectAllKept()
    })
  })

  test('a broken settings file falls back to what a fresh install shows', async ({
    plexo,
    dirs
  }) => {
    const settingsPath = join(dirs.userData, 'app-settings.json')
    // The TO row, as the user sees it — compared whole, so no platform's idea of the default
    // folder is baked into the test.
    const choices = (): Promise<string> =>
      plexo.page.getByText('TO', { exact: true }).locator('..').innerText()
    const fresh = await choices()

    await plexo.quit()
    await writeFile(settingsPath, '{"destinationDir": "/')
    await plexo.launch()
    expect(await choices()).toEqual(fresh)

    await plexo.quit()
    await writeFile(settingsPath, JSON.stringify({ destinationDir: join(dirs.dest, 'unplugged') }))
    await plexo.launch()
    expect(await choices()).toEqual(fresh)
  })
})

test.describe('no networks', () => {
  test.use({ appEnv: { PLEXO_E2E_INTERFACES: '' } })

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
