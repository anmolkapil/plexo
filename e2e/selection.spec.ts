import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BLOCK, expect, test, treeSha } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

async function stubTrash(plexo: import('./fixtures').PlexoApp, destination: string): Promise<void> {
  await mkdir(destination)
  await plexo.evaluateMain(({ shell }, dest) => {
    shell.trashItem = async (path: string): Promise<void> => {
      const { rename } = process.getBuiltinModule('node:fs/promises')
      const { basename, join } = process.getBuiltinModule('node:path')
      await rename(path, join(dest, basename(path)))
    }
  }, destination)
}

test('mixed selection applies actions only to eligible downloads and keeps finished files', async ({
  plexo,
  serve
}) => {
  const complete = await serve({ size: BLOCK })
  await plexo.start(complete.url(), complete.sha256, { fileName: 'finished.bin' })
  const finished = await plexo.waitForStatus('completed')
  const failed = await serve({ size: 16 * BLOCK })
  const held = failed.hold(4 * BLOCK)
  await plexo.start(failed.url(), failed.sha256, { fileName: 'expired.bin' })
  await held
  failed.setRule(() => ({ status: 403 }))
  failed.release()
  await plexo.waitForStatus('error')
  const paused = await serve({ size: 16 * BLOCK })
  const pausedHeld = paused.hold(4 * BLOCK)
  const pausedId = await plexo.start(paused.url(), paused.sha256, { fileName: 'paused.bin' })
  await pausedHeld
  await plexo.api.pauseDownload(pausedId)
  paused.release()
  await plexo.waitForStatus('paused')

  const page = plexo.page
  const beforeSelection = await page
    .getByRole('button', { name: 'Open paused.bin', exact: true })
    .boundingBox()
  await page.getByRole('checkbox', { name: 'Select paused.bin', exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: 'Selected downloads' })
  await expect(page.getByRole('heading', { level: 1 })).toBeHidden()
  await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
  await expect(toolbar.getByText('3 selected', { exact: true })).toBeVisible()
  await expect(page.locator('[data-selected=true]')).toHaveCount(3)
  const afterSelection = await page
    .getByRole('button', { name: 'Open paused.bin', exact: true })
    .boundingBox()
  expect(afterSelection?.y).toBe(beforeSelection?.y)
  await expect(page.getByRole('button', { name: 'Resume (1)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Retry/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Fix link', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Cancel downloads… (2)', exact: true })
  ).toBeVisible()
  await plexo.page.getByRole('button', { name: 'Remove from list (1)', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open finished.bin', exact: true })).toBeHidden()
  expect(existsSync(finished.destinationPath)).toBe(true)
  await expect(toolbar.getByText('2 selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel downloads… (2)', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation.getByText(/deletes their downloaded data/)).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(toolbar.getByText('2 selected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel downloads… (2)', exact: true }).click()
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Cancel downloads', exact: true })
    .click()
  await expect(page.getByText('No downloads yet', { exact: true })).toBeVisible()
  expect(existsSync(finished.destinationPath)).toBe(true)
})

test('missing finished files can leave the list but are excluded from file removal', async ({
  plexo,
  serve
}) => {
  const origin = await serve({ size: BLOCK })
  await plexo.start(origin.url(), origin.sha256)
  const complete = await plexo.waitForStatus('completed')
  // Rename instead of delete so automatic fixture integrity checks can still inspect the bytes.
  const { rename } = await import('node:fs/promises')
  await rename(complete.destinationPath, `${complete.destinationPath}.moved`)
  await plexo.page.reload()
  await plexo.page
    .getByRole('checkbox', { name: `Select ${complete.fileName}`, exact: true })
    .check()
  await expect(plexo.page.getByRole('button', { name: /^Move files/ })).toHaveCount(0)
  await plexo.page.getByRole('button', { name: 'Remove from list (1)', exact: true }).click()
  await expect(plexo.page.getByText('No downloads yet', { exact: true })).toBeVisible()
  await rename(`${complete.destinationPath}.moved`, complete.destinationPath)
})

test('trashing finished torrent files preserves unrelated files in the torrent folder', async ({
  plexo,
  dirs
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [named(seededBytes(BLOCK, 81), 'a.bin'), named(seededBytes(BLOCK, 82), 'b.bin')]
    const torrent = await swarm.seed(files, { folder: 'Owned', pieceLength: 16 * 1024 })
    await plexo.start(
      await torrentFileOnDisk(torrent),
      treeSha(
        files.map((data) => ({
          path: (data as { name?: string }).name!,
          data
        }))
      )
    )
    const completed = await plexo.waitForTorrentStatus('completed')
    await writeFile(join(completed.destinationPath, 'personal.txt'), 'keep me')
    const trash = join(dirs.dest, 'test-trash')
    await stubTrash(plexo, trash)
    await plexo.page
      .getByRole('checkbox', { name: `Select ${completed.fileName}`, exact: true })
      .check()
    await plexo.page.getByRole('button', { name: /^Move files to Trash…/ }).click()
    await plexo.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Move files to Trash', exact: true })
      .click()
    await expect(plexo.page.getByText('No downloads yet', { exact: true })).toBeVisible()
    expect(await readFile(join(completed.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    for (const file of files)
      expect(existsSync(join(trash, basename((file as { name?: string }).name!)))).toBe(true)
  } finally {
    await swarm.stop()
  }
})

test('cancelling an unfinished torrent preserves unrelated files in its folder', async ({
  plexo
}) => {
  const swarm = await new Swarm().start()
  try {
    const files = [
      named(seededBytes(32 * BLOCK, 91), 'a.bin'),
      named(seededBytes(32 * BLOCK, 92), 'b.bin')
    ]
    const torrent = await swarm.seed(files, {
      folder: 'Partial',
      pieceLength: 16 * 1024,
      uploadLimit: 64 * 1024
    })
    const id = await plexo.start(
      await torrentFileOnDisk(torrent),
      treeSha(
        files.map((data) => ({
          path: (data as { name?: string }).name!,
          data
        }))
      )
    )
    await plexo.api.pauseDownload(id)
    const paused = await plexo.waitForTorrentStatus('paused')
    await writeFile(join(paused.destinationPath, 'personal.txt'), 'keep me')
    await plexo.api.removeDownload(id)
    expect(await readFile(join(paused.destinationPath, 'personal.txt'), 'utf8')).toBe('keep me')
    expect(existsSync(join(paused.destinationPath, 'a.bin'))).toBe(false)
    expect(existsSync(join(paused.destinationPath, 'b.bin'))).toBe(false)
  } finally {
    await swarm.stop()
  }
})
