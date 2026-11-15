import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'

/** The destination picker goes through native OS UI — stub it. */
async function stubNativeUi(
  plexo: import('./fixtures').PlexoApp,
  destination: string
): Promise<void> {
  await plexo.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

test.describe('pinned default download location & settings preferences', () => {
  test('Settings dialog opens via status bar button and shortcut', async ({ plexo }) => {
    const page = plexo.page
    // Open via status bar button
    const settingsBtn = page.getByRole('button', { name: 'Settings', exact: true })
    await expect(settingsBtn).toBeVisible()
    await settingsBtn.click()
    const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Open via keyboard shortcut
    const isMac = await plexo.evaluateMain(() => process.platform === 'darwin', null)
    await page.keyboard.press(isMac ? 'Meta+,' : 'Control+,')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  })

  test('pinned default download directory persists across relaunches', async ({ plexo, dirs }) => {
    const customDir = join(dirs.dest, 'PinnedDownloads')
    await mkdir(customDir, { recursive: true })
    await stubNativeUi(plexo, customDir)

    const page = plexo.page
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
    await expect(dialog).toBeVisible()

    // Under Default download folder section, click Change
    const defaultFolderSection = dialog.locator('section', { hasText: 'Default download folder' })
    await defaultFolderSection.getByRole('button', { name: 'Change' }).click()
    // Save
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Verify New download defaults to pinned folder
    await plexo.newDownload()
    const newDownloadDialog = page.getByRole('dialog', { name: 'New download' })
    await expect(newDownloadDialog.getByText(customDir)).toBeVisible()
    await page.keyboard.press('Escape')

    // Relaunch app and verify setting persisted
    await plexo.relaunch()
    const pageAfter = plexo.page
    await pageAfter.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialogAfter = pageAfter.getByRole('dialog', { name: 'Speed & data limits' })
    const sectionAfter = dialogAfter.locator('section', { hasText: 'Default download folder' })
    await expect(sectionAfter.getByText(customDir)).toBeVisible()
    await dialogAfter.getByRole('button', { name: 'Cancel' }).click()
  })

  test('one-off folder changes in New Download do not overwrite pinned default', async ({
    plexo,
    dirs,
    serve
  }) => {
    const pinnedDir = join(dirs.dest, 'PinnedDir')
    const oneOffDir = join(dirs.dest, 'OneOffDir')
    await mkdir(pinnedDir, { recursive: true })
    await mkdir(oneOffDir, { recursive: true })

    await plexo.api.updateSettings({ defaultDestinationDir: pinnedDir })
    await plexo.relaunch()
    await stubNativeUi(plexo, oneOffDir)

    const origin = await serve({ size: 1024 })
    const link = await plexo.newDownload()
    await link.fill(origin.url())

    const newDownloadDialog = plexo.page.getByRole('dialog', { name: 'New download' })
    await expect(newDownloadDialog.getByText(pinnedDir)).toBeVisible()

    // Change folder for this one download
    await newDownloadDialog.getByRole('button', { name: 'Change' }).click()
    await expect(newDownloadDialog.getByText(oneOffDir)).toBeVisible()

    // Start download
    await newDownloadDialog.getByRole('button', { name: 'Download' }).click()
    await plexo.waitForHttpStatus('completed')

    // Navigate back to downloads list
    await plexo.page.getByRole('button', { name: 'Downloads' }).click()

    // Open New download again — it must still default to pinnedDir!
    await plexo.newDownload()
    await expect(newDownloadDialog.getByText(pinnedDir)).toBeVisible()
    await plexo.page.keyboard.press('Escape')
  })

  test('changing default download directory updates the destination', async ({ plexo, dirs }) => {
    const customDir = join(dirs.dest, 'CustomDir')
    const secondDir = join(dirs.dest, 'SecondDir')
    await mkdir(customDir, { recursive: true })
    await mkdir(secondDir, { recursive: true })
    await plexo.api.updateSettings({ defaultDestinationDir: customDir })
    await plexo.relaunch()
    await stubNativeUi(plexo, secondDir)

    const page = plexo.page
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
    const section = dialog.locator('section', { hasText: 'Default download folder' })
    await expect(section.getByText(customDir)).toBeVisible()

    // Click Change
    await section.getByRole('button', { name: 'Change' }).click()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Verify settings updated on disk
    const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    expect(saved.defaultDestinationDir).toBe(secondDir)
  })

  test('a missing pinned folder falls back safely and can be changed', async ({ plexo, dirs }) => {
    const missingDir = join(dirs.dest, 'unplugged')

    await plexo.api.updateSettings({
      defaultDestinationDir: missingDir
    })
    await plexo.relaunch()

    await plexo.newDownload()
    const dialog = plexo.page.getByRole('dialog', { name: 'New download' })
    const destinationRow = dialog.getByText('Save to', { exact: true }).locator('..')
    // Main rejects the missing pinned folder before the renderer sees it, so the dialog shows its
    // usable fallback and exposes Change.
    await expect(destinationRow).toBeVisible()
    await expect(destinationRow).not.toContainText(missingDir)
    await expect(destinationRow.getByRole('button', { name: 'Change' })).toBeVisible()
    await plexo.page.keyboard.press('Escape')

    // Verify Settings also indicates that the pinned folder is missing
    await plexo.page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsDialog = plexo.page.getByRole('dialog', { name: 'Speed & data limits' })
    const section = settingsDialog.locator('section', { hasText: 'Default download folder' })
    await expect(section.getByText(/folder missing/i)).toBeVisible()
    await settingsDialog.getByRole('button', { name: 'Cancel' }).click()
  })

  test('pinned default folder can be unpinned with Reset to default', async ({ plexo, dirs }) => {
    const customDir = join(dirs.dest, 'PinnedToUnpin')
    await mkdir(customDir, { recursive: true })
    await plexo.api.updateSettings({ defaultDestinationDir: customDir })
    await plexo.relaunch()

    const page = plexo.page
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
    const section = dialog.locator('section', { hasText: 'Default download folder' })
    await expect(section.getByText(customDir)).toBeVisible()

    // Click Reset to default
    const resetBtn = section.getByRole('button', { name: 'Reset to default' })
    await expect(resetBtn).toBeVisible()
    await resetBtn.click()

    // Button disappears and Save persists unpinned state
    await expect(resetBtn).toBeHidden()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Verify disk settings have cleared defaultDestinationDir
    const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    expect(saved.defaultDestinationDir).toBeUndefined()
  })

  test('Settings shows the effective legacy download folder', async ({ plexo, dirs }) => {
    const legacyDir = join(dirs.dest, 'LegacyDownloads')
    await mkdir(legacyDir, { recursive: true })
    await plexo.api.updateSettings({ destinationDir: legacyDir })
    await plexo.relaunch()

    await plexo.page.getByRole('button', { name: 'Settings', exact: true }).click()
    const section = plexo.page
      .getByRole('dialog', { name: 'Speed & data limits' })
      .locator('section', { hasText: 'Default download folder' })
    await expect(section.getByText(legacyDir)).toBeVisible()
    await expect(section.getByText('(system default)')).toBeHidden()
    await plexo.page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('without pinned default, folder changes in New Download update remembered destination', async ({
    plexo,
    dirs,
    serve
  }) => {
    const rememberedDir = join(dirs.dest, 'RememberedDir')
    await mkdir(rememberedDir, { recursive: true })
    await stubNativeUi(plexo, rememberedDir)

    const origin = await serve({ size: 1024 })
    const link = await plexo.newDownload()
    await link.fill(origin.url())

    const dialog = plexo.page.getByRole('dialog', { name: 'New download' })
    await dialog.getByRole('button', { name: 'Change' }).click()
    await expect(dialog.getByText(rememberedDir)).toBeVisible()
    await dialog.getByRole('button', { name: 'Download' }).click()
    await plexo.waitForHttpStatus('completed')

    // Next new download without a pinned default should remember this directory
    await plexo.page.getByRole('button', { name: 'Downloads' }).click()
    await plexo.newDownload()
    const dialogNext = plexo.page.getByRole('dialog', { name: 'New download' })
    await expect(dialogNext.getByText(rememberedDir)).toBeVisible()
    await plexo.page.keyboard.press('Escape')

    // Verify settings updated on disk
    const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    expect(saved.destinationDir).toBe(rememberedDir)
    expect(saved.defaultDestinationDir).toBeUndefined()
  })

  test('resumed download continues saving to its original destination directory', async ({
    plexo,
    dirs,
    serve
  }) => {
    const originalDir = join(dirs.dest, 'OriginalDest')
    const newDefaultDir = join(dirs.dest, 'NewDefaultDest')
    await mkdir(originalDir, { recursive: true })
    await mkdir(newDefaultDir, { recursive: true })

    await stubNativeUi(plexo, originalDir)
    const origin = await serve({ size: 100 * 1024, bytesPerSecond: 20 * 1024 })
    const link = await plexo.newDownload()
    await link.fill(origin.url())

    const dialog = plexo.page.getByRole('dialog', { name: 'New download' })
    await dialog.getByRole('button', { name: 'Change' }).click()
    await expect(dialog.getByText(originalDir)).toBeVisible()
    await dialog.getByRole('button', { name: 'Download' }).click()

    // Wait for the download to start and pause it
    const pauseBtn = plexo.page.getByRole('button', { name: 'Pause' })
    await expect(pauseBtn).toBeVisible()
    await pauseBtn.click()
    await plexo.waitForHttpStatus('paused')

    // Change default destination directory in Settings
    await plexo.api.updateSettings({ defaultDestinationDir: newDefaultDir })
    await plexo.relaunch()

    // Resume the download
    const resumeBtn = plexo.page.getByRole('button', { name: 'Resume' })
    await expect(resumeBtn).toBeVisible()
    await resumeBtn.click()
    await plexo.waitForHttpStatus('completed')

    // Verify completed file exists in originalDir, not newDefaultDir
    const originalFiles = await readdir(originalDir)
    expect(originalFiles.length).toBeGreaterThan(0)
    const newDefaultFiles = await readdir(newDefaultDir)
    expect(newDefaultFiles.length).toBe(0)

    // And verify subsequent new download defaults to newDefaultDir
    await plexo.newDownload()
    const newDialog = plexo.page.getByRole('dialog', { name: 'New download' })
    await expect(newDialog.getByText(newDefaultDir)).toBeVisible()
    await plexo.page.keyboard.press('Escape')
  })
})
