import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'
import { seededBytes } from './origin'

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
    await expect(sectionAfter.getByRole('button', { name: 'Reset to default' })).toBeVisible()
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

  test('resetting default download directory reverts to system default', async ({
    plexo,
    dirs
  }) => {
    const customDir = join(dirs.dest, 'CustomDir')
    await mkdir(customDir, { recursive: true })
    await plexo.api.updateSettings({ defaultDestinationDir: customDir })
    await plexo.relaunch()

    const page = plexo.page
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Speed & data limits' })
    const section = dialog.locator('section', { hasText: 'Default download folder' })
    await expect(section.getByText(customDir)).toBeVisible()

    // Click Reset to default
    await section.getByRole('button', { name: 'Reset to default' }).click()
    await expect(section.getByText('(system default)')).toBeVisible()
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Verify settings updated on disk
    const saved = JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
    expect(saved.defaultDestinationDir).toBeUndefined()
  })

  test('disabling save location prompt automatically starts handed-over downloads', async ({
    plexo
  }) => {
    const swarm = await new Swarm().start()
    try {
      const torrent = await swarm.seed([named(seededBytes(1024, 42), 'auto.bin')])
      const torrentPath = await torrentFileOnDisk(torrent)

      await plexo.api.updateSettings({ askDestinationEachTime: false })
      await plexo.relaunch()

      // Hand over the .torrent file to the app
      await plexo.evaluateMain(({ app }, path) => {
        app.emit('open-url', { preventDefault: () => undefined }, path)
      }, torrentPath)

      // Handed over link should automatically start downloading without manual click
      await plexo.waitForTorrentStatus('completed', 20_000)
      const completed = await plexo.current()
      expect(completed?.status).toBe('completed')
    } finally {
      await swarm.stop()
    }
  })
})
