import type { Locator } from '@playwright/test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type PlexoApp } from './fixtures'

// Issue #258: Start Plexo minimized in system tray and launch at startup.
// Settings under General: "Launch on startup" and "Start minimized".

const MAGNET = `magnet:?xt=urn:btih:${'ab'.repeat(20)}&dn=startup.test`

async function openSettingsDialog(plexo: PlexoApp): Promise<Locator> {
  await plexo.page.getByRole('button', { name: 'Settings', exact: true }).click()
  return plexo.page.getByRole('dialog', { name: 'Settings' })
}

test.describe('startup and minimized settings @smoke', () => {
  test('start minimized and launch on startup settings persist across app relaunches', async ({
    plexo,
    dirs
  }) => {
    const initial = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(initial.openAtLogin ?? false).toBe(false)
    expect(initial.startMinimized ?? false).toBe(false)

    await plexo.api.updateSettings({ openAtLogin: true, startMinimized: true })

    const settingsFile = join(dirs.userData, 'app-settings.json')
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(saved.openAtLogin).toBe(true)
    expect(saved.startMinimized).toBe(true)

    if (process.platform === 'linux') {
      const desktopPath = join(dirs.userData, 'autostart', 'plexo.desktop')
      expect(existsSync(desktopPath)).toBe(true)
      const desktop = await readFile(desktopPath, 'utf8')
      expect(desktop).toContain('Exec="')
      expect(desktop).toContain('" --minimized')
    }

    await plexo.relaunch()

    const relaunched = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(relaunched.openAtLogin).toBe(true)
    expect(relaunched.startMinimized).toBe(true)

    await plexo.api.updateSettings({ openAtLogin: false, startMinimized: false })
    if (process.platform === 'linux') {
      expect(existsSync(join(dirs.userData, 'autostart', 'plexo.desktop'))).toBe(false)
    }
    await plexo.relaunch()

    const restored = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(restored.openAtLogin).toBe(false)
    expect(restored.startMinimized).toBe(false)
  })

  test('toggling startup and start minimized in settings UI saves and is kept by download reset', async ({
    plexo,
    dirs
  }) => {
    const dialog = await openSettingsDialog(plexo)
    const launchSwitch = dialog.getByRole('switch', { name: 'Launch on startup', exact: true })
    const minimizedSwitch = dialog.getByRole('switch', { name: 'Start minimized', exact: true })

    await expect(launchSwitch).not.toBeChecked()
    await expect(minimizedSwitch).not.toBeChecked()

    await launchSwitch.check()
    await minimizedSwitch.check()

    await expect(launchSwitch).toBeChecked()
    await expect(minimizedSwitch).toBeChecked()

    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()

    const settingsFile = join(dirs.userData, 'app-settings.json')
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(saved.openAtLogin).toBe(true)
    expect(saved.startMinimized).toBe(true)

    // Reopen dialog to verify UI reflects saved settings
    const reopened = await openSettingsDialog(plexo)
    await expect(
      reopened.getByRole('switch', { name: 'Launch on startup', exact: true })
    ).toBeChecked()
    await expect(
      reopened.getByRole('switch', { name: 'Start minimized', exact: true })
    ).toBeChecked()

    // Change a download setting so "Reset to defaults" is enabled, then verify startup toggles stay on.
    await reopened
      .getByRole('button', { name: 'Increase simultaneous downloads', exact: true })
      .click()
    await expect(reopened.getByLabel('Downloads at once')).toHaveText('3')

    await reopened.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    const confirmDialog = plexo.page.getByRole('alertdialog', {
      name: 'Reset all downloads to defaults?'
    })
    await confirmDialog.getByRole('button', { name: 'Reset to defaults', exact: true }).click()

    await expect(reopened.getByLabel('Downloads at once')).toHaveText('2')
    await expect(
      reopened.getByRole('switch', { name: 'Launch on startup', exact: true })
    ).toBeChecked()
    await expect(
      reopened.getByRole('switch', { name: 'Start minimized', exact: true })
    ).toBeChecked()

    await reopened.getByRole('switch', { name: 'Launch on startup', exact: true }).uncheck()
    await reopened.getByRole('switch', { name: 'Start minimized', exact: true }).uncheck()
    await reopened.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(reopened).toBeHidden()

    const resetSaved = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(resetSaved.openAtLogin).toBe(false)
    expect(resetSaved.startMinimized).toBe(false)
  })

  test('launching with --minimized keeps the window hidden unless a link is passed', async ({
    plexo
  }) => {
    await plexo.quit()
    await plexo.launch({ PLEXO_E2E_HIDE_WINDOW: '0' }, ['--minimized'])
    expect(plexo.alive).toBe(true)

    const hiddenVisible = await plexo.evaluateMain(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible(),
      null
    )
    expect(hiddenVisible).toBe(false)

    await plexo.quit()
    await plexo.launch({ PLEXO_E2E_HIDE_WINDOW: '0' }, ['--minimized', MAGNET])
    await expect
      .poll(() =>
        plexo.evaluateMain(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible(),
          null
        )
      )
      .toBe(true)
    await expect(plexo.page.getByRole('textbox', { name: 'Link' })).toHaveValue(MAGNET)
  })

  test('saved startMinimized setting does not hide a manual launch', async ({ plexo }) => {
    await plexo.api.updateSettings({ startMinimized: true })
    await plexo.quit()
    await plexo.launch({ PLEXO_E2E_HIDE_WINDOW: '0' })

    await expect
      .poll(() =>
        plexo.evaluateMain(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible(),
          null
        )
      )
      .toBe(true)
  })
})
