import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { errorClass, errorStatus } from '../src/shared/errors'
import {
  durationBucket,
  networkCount,
  networkKinds,
  sizeBucket,
  speedBucket,
  stackFrames,
  validStatsBatch,
  validStatsEvent,
  type StatsBatch
} from '../src/shared/stats'
import { BLOCK, expect, makeDirs, PlexoApp, test } from './fixtures'

// Anonymous usage and error stats (main/stats.ts). A test build never sends them unless given
// an address, as these tests do: a local server that keeps every batch it's sent.

class Collector {
  readonly bodies: string[] = []
  private server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      this.bodies.push(body)
      response.writeHead(204).end()
    })
  })

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return this
  }

  get url(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('not listening')
    return `http://127.0.0.1:${address.port}/api/events`
  }

  get batches(): StatsBatch[] {
    return this.bodies.map((body) => JSON.parse(body) as StatsBatch)
  }

  events(name: string): StatsBatch['events'] {
    return this.batches.flatMap((batch) => batch.events).filter((event) => event.name === name)
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

async function launch(dirs: { userData: string; dest: string }, url: string): Promise<PlexoApp> {
  return new PlexoApp(dirs).launch({
    PLEXO_E2E_STATS_URL: url,
    PLEXO_E2E_STATS_EVERY_MS: '300'
  })
}

/** Speed & data limits, from the networks menu, on its General page. */
async function openLimits(app: PlexoApp): Promise<void> {
  await app.page.getByRole('button', { name: /^\d+ networks?/ }).click()
  await app.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
}

async function settings(dirs: { userData: string }): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dirs.userData, 'app-settings.json'), 'utf8'))
}

test.describe('anonymous stats @smoke', () => {
  let collector: Collector
  // Folders of their own: the fixture's app already has the test's, one Plexo to a folder.
  let dirs: { userData: string; dest: string }
  let dispose: () => Promise<void>
  test.beforeEach(async () => {
    collector = await new Collector().start()
    ;({ dirs, dispose } = await makeDirs())
  })
  test.afterEach(async () => {
    await collector.stop()
    await dispose()
  })

  test('after the notice, events are sent, and nothing in them names a link, file, folder or address', async ({
    serve
  }) => {
    const app = await launch(dirs, collector.url)
    try {
      const notice = app.page.getByRole('region', { name: 'Anonymous stats' })
      await expect(notice).toBeVisible()
      // Nothing goes before the notice is read, though app_start is waiting.
      await app.page.waitForTimeout(1000)
      expect(collector.bodies).toHaveLength(0)
      await notice.getByRole('button', { name: 'OK' }).click()
      await expect(notice).toBeHidden()
      await expect.poll(async () => (await settings(dirs)).statsNoticeShown).toBe(true)

      // A token in the link and the file name: it must turn up nowhere in what's sent.
      const canary = 'canary7f3e9b'
      const origin = await serve({ size: 8 * BLOCK })
      await app.start(origin.url(`/files/${canary}-movie.bin`), origin.sha256, {
        fileName: `${canary}-movie.bin`
      })
      await app.waitForStatus('completed')

      await expect.poll(() => collector.events('download_finished').length).toBe(1)
      expect(collector.events('app_start')).toHaveLength(1)
      const [finished] = collector.events('download_finished')
      expect(finished.props).toMatchObject({ type: 'http', size: '<10MB' })
      expect((finished.props as Record<string, string>).networks).not.toBe('none')

      const { statsInstallId } = await settings(dirs)
      for (const batch of collector.batches) {
        expect(validStatsBatch(batch)).toBe(true)
        expect(batch.events.every(validStatsEvent)).toBe(true)
        expect(batch.install_id).toBe(statsInstallId)
      }
      const sent = collector.bodies.join('\n')
      const port = new URL(origin.url()).port
      for (const secret of [canary, dirs.userData, dirs.dest, homedir(), '127.0.0.1', port]) {
        expect(sent).not.toContain(secret)
      }
    } finally {
      await app.quit()
    }
  })

  test('a failed download sends its error class and status, not its error', async ({ serve }) => {
    await writeFile(
      join(dirs.userData, 'app-settings.json'),
      JSON.stringify({ statsNoticeShown: true })
    )
    const app = await launch(dirs, collector.url)
    try {
      await expect(app.page.getByRole('region', { name: 'Anonymous stats' })).toHaveCount(0)
      const origin = await serve({ size: 16 * BLOCK })
      const held = origin.hold(4 * BLOCK)
      await app.start(origin.url(), origin.sha256)
      await held
      origin.setRule(() => ({ status: 403 }))
      origin.release()
      await app.waitUntil((state) => state.status === 'error', 30_000)

      await expect.poll(() => collector.events('download_failed').length).toBe(1)
      expect(collector.events('download_failed')[0].props).toMatchObject({
        type: 'http',
        error_class: 'link_refused',
        http_status: '403'
      })
      expect(collector.bodies.join('\n')).not.toContain('range request')
    } finally {
      await app.quit()
    }
  })

  test('turned off from the notice: nothing is sent and the id is gone; back on, a new id', async ({
    serve
  }) => {
    const app = await launch(dirs, collector.url)
    try {
      const notice = app.page.getByRole('region', { name: 'Anonymous stats' })
      await notice.getByRole('button', { name: 'Turn off' }).click()
      await expect(notice).toBeHidden()
      await expect.poll(async () => (await settings(dirs)).shareStats).toBe(false)

      const origin = await serve({ size: 4 * BLOCK })
      await app.start(origin.url(), origin.sha256)
      await app.waitForStatus('completed')
      // Several send intervals pass.
      await app.page.waitForTimeout(1500)
      expect(collector.bodies).toHaveLength(0)
      expect((await settings(dirs)).statsInstallId).toBeUndefined()

      // Back on in Speed & data limits.
      await openLimits(app)
      const dialog = app.page.getByRole('dialog', { name: 'Speed & data limits' })
      const toggle = dialog.getByRole('switch', { name: 'Share anonymous usage and error stats' })
      await expect(toggle).not.toBeChecked()
      await toggle.click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect(dialog).toBeHidden()
      await expect.poll(async () => (await settings(dirs)).shareStats).toBeUndefined()

      const again = await serve({ size: 4 * BLOCK, seed: 2 })
      await app.start(again.url(), again.sha256)
      await expect.poll(() => collector.events('download_finished').length).toBe(1)
      const { statsInstallId } = await settings(dirs)
      expect(statsInstallId).toMatch(/^[0-9a-f-]{36}$/)
      expect(collector.batches.at(-1)!.install_id).toBe(statsInstallId)

      // Off again: the id is deleted, and the next one will be new.
      await openLimits(app)
      await dialog.getByRole('switch', { name: 'Share anonymous usage and error stats' }).click()
      await dialog.getByRole('button', { name: 'Save' }).click()
      await expect.poll(async () => (await settings(dirs)).statsInstallId).toBeUndefined()
    } finally {
      await app.quit()
    }
  })

  test('the window cannot set the install id or mark the notice shown', async () => {
    const app = await launch(dirs, collector.url)
    try {
      await app.page
        .getByRole('region', { name: 'Anonymous stats' })
        .getByRole('button', { name: 'OK' })
        .click()
      await expect.poll(async () => (await settings(dirs)).statsNoticeShown).toBe(true)
      const id = '11111111-1111-4111-8111-111111111111'
      await app.api.updateSettings({ statsInstallId: id, statsNoticeShown: false })
      const saved = await settings(dirs)
      expect(saved.statsInstallId).not.toBe(id)
      expect(saved.statsNoticeShown).toBe(true)
    } finally {
      await app.quit()
    }
  })
})

test('stats: error classes never carry the error text', () => {
  expect(errorClass('getaddrinfo ENOTFOUND files.example.com')).toBe('dns')
  expect(errorClass('Server responded with status 403 for range request')).toBe('link_refused')
  expect(errorClass('Unexpected status 503')).toBe('http_5xx')
  expect(errorClass('ENOSPC: no space left on device, write')).toBe('no_space')
  expect(errorClass('Too many redirects for range request')).toBe('too_many_redirects')
  expect(errorClass('Connecting to proxy 10.0.0.2:1080 timed out')).toBe('proxy_timeout')
  expect(errorClass('something nobody has seen, at /Users/someone/file.bin')).toBe('other')
  expect(errorStatus('Server responded with status 416 for range request')).toBe('416')
  expect(errorStatus('ECONNRESET')).toBe('')
})

test('stats: only Plexo’s own frames, file and line only', () => {
  const stack = [
    'TypeError: Cannot read properties of undefined',
    '    at run (C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Plexo\\resources\\app.asar\\out\\main\\index.js:1203:17)',
    '    at file:///Users/jane/Applications/Plexo.app/Contents/Resources/app.asar/out/renderer/assets/index-BDfsWiUU.js:40:9',
    '    at node:internal/process/task_queues:95:5',
    '    at /Users/jane/secret-project/evil.js:1:1'
  ].join('\n')
  expect(stackFrames(stack)).toBe('index.js:1203;index-BDfsWiUU.js:40')
  expect(stackFrames(undefined)).toBe('')
})

test('stats: buckets, network kinds and the event list', () => {
  expect(sizeBucket(0)).toBe('0')
  expect(sizeBucket(50 * 1024 ** 2)).toBe('10-100MB')
  expect(sizeBucket(20 * 1024 ** 3)).toBe('>10GB')
  expect(durationBucket(5 * 60_000)).toBe('1-10m')
  expect(speedBucket(30 * 1024 ** 2)).toBe('20-50MB/s')
  expect(
    networkKinds([
      { kind: 'wifi', bytesDownloaded: 10 },
      { kind: 'usb', bytesDownloaded: 5 },
      { kind: 'ethernet', bytesDownloaded: 0 }
    ])
  ).toBe('usb,wifi')
  expect(networkCount([{ kind: 'wifi' }, { kind: 'wifi' }, { kind: 'usb' }])).toBe('usb:1,wifi:2')

  const valid = { name: 'update_failed', props: { error_class: 'tls' } }
  expect(validStatsEvent(valid)).toBe(true)
  // Not on the list, an extra field, or a value of the wrong shape: refused.
  expect(validStatsEvent({ name: 'page_view', props: {} })).toBe(false)
  expect(validStatsEvent({ ...valid, props: { error_class: 'tls', url: 'x' } })).toBe(false)
  expect(validStatsEvent({ name: 'update_failed', props: { error_class: 'Not Found' } })).toBe(
    false
  )
  expect(
    validStatsEvent({
      name: 'app_error',
      props: { process: 'main', name: 'Error', error_class: 'other', frames: '/Users/x/a.js:1' }
    })
  ).toBe(false)
})
