import type { Locator } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type PlexoApp } from './fixtures'

// Issue #258: Start Plexo minimized in system tray and launch at startup.
// Settings under General: "Launch on startup" and "Start minimized".

async function openLimitsDialog(plexo: PlexoApp): Promise<Locator> {
  await plexo.page.getByRole('button', { name: /^\d+ networks?/ }).click()
  await plexo.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
  return plexo.page.getByRole('dialog', { name: 'Speed & data limits' })
}

test.describe('startup and minimized settings @smoke', () => {
  test('start minimized and launch on startup settings persist across app relaunches', async ({
    plexo,
    dirs
  }) => {
    const initial = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(initial.startMinimized ?? false).toBe(false)

    await plexo.api.updateSettings({ openAtLogin: true, startMinimized: true })

    const settingsFile = join(dirs.userData, 'app-settings.json')
    const saved = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(saved.openAtLogin).toBe(true)
    expect(saved.startMinimized).toBe(true)

    await plexo.relaunch()

    const relaunched = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(relaunched.openAtLogin).toBe(true)
    expect(relaunched.startMinimized).toBe(true)

    await plexo.api.updateSettings({ openAtLogin: false, startMinimized: false })
    await plexo.relaunch()

    const restored = await plexo.page.evaluate(() => window.plexo.initialState)
    expect(restored.openAtLogin).toBe(false)
    expect(restored.startMinimized).toBe(false)
  })

  test('toggling startup and start minimized in settings UI saves and persists', async ({
    plexo,
    dirs
  }) => {
    const dialog = await openLimitsDialog(plexo)
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
    const reopened = await openLimitsDialog(plexo)
    await expect(
      reopened.getByRole('switch', { name: 'Launch on startup', exact: true })
    ).toBeChecked()
    await expect(
      reopened.getByRole('switch', { name: 'Start minimized', exact: true })
    ).toBeChecked()

    // Test "Reset to defaults" resets both toggles
    await reopened.getByRole('button', { name: 'Reset to defaults', exact: true }).click()
    const confirmDialog = plexo.page.getByRole('alertdialog', {
      name: 'Reset all downloads to defaults?'
    })
    await confirmDialog.getByRole('button', { name: 'Reset to defaults', exact: true }).click()

    await expect(
      reopened.getByRole('switch', { name: 'Launch on startup', exact: true })
    ).not.toBeChecked()
    await expect(
      reopened.getByRole('switch', { name: 'Start minimized', exact: true })
    ).not.toBeChecked()

    await reopened.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(reopened).toBeHidden()

    const resetSaved = JSON.parse(await readFile(settingsFile, 'utf8'))
    expect(resetSaved.openAtLogin).toBe(false)
    expect(resetSaved.startMinimized).toBe(false)
  })

  test('launching with --minimized CLI argument starts cleanly', async ({ plexo }) => {
    await plexo.quit()
    await plexo.launch({}, ['--minimized'])
    expect(plexo.alive).toBe(true)
    expect(plexo.page).toBeDefined()
  })
})
