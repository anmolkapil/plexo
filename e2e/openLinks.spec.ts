import type { Locator } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { electronArgs, expect, PROJECT_ROOT, test, type PlexoApp } from './fixtures'
import { seededBytes } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// Links the OS hands Plexo — a magnet link clicked in a browser, a .torrent opened from the file
// manager — open New download with it filled in, for the user to look at and start; nothing starts
// on its own.

const MAGNET = `magnet:?xt=urn:btih:${'cd'.repeat(20)}&dn=handed.over`

/** A .torrent of one small file, on disk. */
async function aTorrentFile(): Promise<string> {
  const swarm = await new Swarm().start()
  try {
    return await torrentFileOnDisk(await swarm.seed([named(seededBytes(1000, 91), 'clip.mov')]))
  } finally {
    await swarm.stop()
  }
}

const linkField = (plexo: PlexoApp): Locator => plexo.page.getByRole('textbox', { name: 'Link' })

test.describe('links handed over by the OS', () => {
  test('a .torrent on the command line (Windows, Linux) fills in the link', async ({ plexo }) => {
    const path = await aTorrentFile()
    await plexo.quit()
    await plexo.launch({}, [path])

    await expect(linkField(plexo)).toHaveValue(path)
    await expect(plexo.page.getByRole('group', { name: 'Files' })).toBeVisible({ timeout: 15_000 })
    // Shown, not started.
    expect(await plexo.current()).toBeNull()
  })

  test('a second launch hands its magnet link to the first window, and exits', async ({
    plexo
  }) => {
    const electronBinary = createRequire(__filename)('electron') as string
    const second = spawn(electronBinary, electronArgs(PROJECT_ROOT, [MAGNET]), {
      env: { ...process.env, PLEXO_USER_DATA: plexo.dirs.userData, PLEXO_E2E_HIDE_WINDOW: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const output: string[] = []
    second.stdout?.on('data', (data) => output.push(String(data)))
    second.stderr?.on('data', (data) => output.push(String(data)))
    try {
      const exit = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          second.once('error', reject)
          second.once('close', (code, signal) => resolve({ code, signal }))
        }
      )
      expect(exit, output.join('')).toEqual({ code: 0, signal: null })
    } finally {
      if (second.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
    }
    await expect(linkField(plexo)).toHaveValue(MAGNET)
  })

  test('macOS’s open-url and open-file fill in the link; anything else is ignored', async ({
    plexo
  }) => {
    const emit = (event: 'open-url' | 'open-file', link: string): Promise<unknown> =>
      plexo.evaluateMain(
        ({ app }, [name, value]) => app.emit(name, { preventDefault: () => undefined }, value),
        [event, link] as const
      )

    await emit('open-url', 'https://example.com/not-a-torrent')
    await emit('open-file', '/no/such/file.torrent')
    // Neither is taken: New download doesn't open for them.
    await expect(linkField(plexo)).toBeHidden()

    await emit('open-url', MAGNET)
    await expect(linkField(plexo)).toHaveValue(MAGNET)

    const path = await aTorrentFile()
    await emit('open-file', path)
    await expect(linkField(plexo)).toHaveValue(path)
  })
})
