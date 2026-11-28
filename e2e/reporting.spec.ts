import { test as base, expect, type Locator } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { SourceMap } from 'node:module'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Event } from '@sentry/electron/main'
import { BLOCK, finishWelcome, LAN_ADDRESS, makeDirs, PlexoApp, PROJECT_ROOT } from './fixtures'
import { NewsServer } from './newsServer'
import { isProbe, Origin } from './origin'

const canaries = [
  'private-link-canary',
  'secret-file-canary.zip',
  '/private/path-canary',
  'password-canary'
]
const secret = canaries.join(' ')
interface Sink {
  port: number
  bodies: string[]
  delivered: string[]
  events(): Event[]
  setOffline(value: boolean): void
  close(): Promise<void>
}

async function localSink(): Promise<Sink> {
  const bodies: string[] = []
  const delivered: string[] = []
  let offline = false
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(403).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    bodies.push((req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString())
    if (offline) req.socket.destroy()
    else {
      delivered.push(bodies.at(-1)!)
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    delivered,
    events: (): Event[] => bodies.map((body) => JSON.parse(body.split('\n')[2])),
    setOffline(value: boolean) {
      offline = value
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const test = base.extend<{ sink: Sink; app: PlexoApp }>({
  // eslint-disable-next-line no-empty-pattern
  sink: async ({}, use) => {
    const sink = await localSink()
    try {
      await use(sink)
    } finally {
      await sink.close()
    }
  },
  app: async ({ sink }, use) => {
    const { dirs, dispose } = await makeDirs()
    const app = new PlexoApp(dirs, {
      PLEXO_E2E_SENTRY_PORT: String(sink.port),
      PLEXO_E2E_MANUAL_WELCOME: '1',
      DO_NOT_TRACK: '0'
    })
    try {
      await use(app)
    } finally {
      if (app.alive) await app.quit()
      await dispose()
    }
  }
})

async function privacy(app: PlexoApp): Promise<Locator> {
  await expect(app.page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await app.page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  const settings = app.page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Privacy' }).click()
  return settings.getByRole('switch', { name: 'Send crash reports' })
}

function verifyMaps(event: Event): Promise<void[]> {
  const images = event.debug_meta?.images ?? []
  expect(images.length).toBeGreaterThan(0)
  return Promise.all(
    images.map(async (image) => {
      if (image.type !== 'sourcemap') throw new Error('Expected a source map')
      const map = JSON.parse(
        await readFile(join(PROJECT_ROOT, image.code_file.slice('app:///'.length) + '.map'), 'utf8')
      )
      expect(map.debug_id ?? map.debugId).toBe(image.debug_id)
      const sourceMap = new SourceMap(map)
      const frames = event.exception?.values?.[0].stacktrace?.frames ?? []
      expect(
        frames.some((frame) => {
          if (frame.filename !== image.code_file || !frame.lineno || !frame.colno) return false
          const origin = sourceMap.findEntry(frame.lineno - 1, frame.colno - 1)
          return (
            'originalSource' in origin &&
            /src\/(main|renderer)\/.+\.tsx?$/.test(origin.originalSource)
          )
        })
      ).toBe(true)
    })
  )
}

test('consent, live opt-out, offline loss, restart and DNT @smoke', async ({ app, sink }) => {
  await app.launch()
  const welcome = app.page.getByRole('dialog')
  await welcome.getByRole('button', { name: 'Next' }).click()
  await expect(welcome.getByRole('switch')).toBeChecked()
  await welcome.getByText('What’s sent').click()
  await expect(welcome.getByText(/Your links, files or downloads/)).toBeVisible()
  const refused = (): Promise<void> =>
    expect(
      app.api.probeUrl('http://127.0.0.1:' + sink.port + '/private-link-canary')
    ).rejects.toThrow('403')
  await refused()
  await welcome.getByRole('switch').click()
  await finishWelcome(app.page)
  await welcome.waitFor({ state: 'hidden' })
  await refused()
  await app.relaunch()
  await expect(app.page.getByRole('dialog')).toHaveCount(0)
  const toggle = await privacy(app)
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await refused()
  await expect.poll(() => sink.bodies.length).toBe(1)

  // One failed send while enabled. Turn off before connectivity returns and then quit.
  sink.setOffline(true)
  await refused()
  // Chromium can resend the same request on a fresh socket after a connection reset.
  await expect.poll(() => new Set(sink.events().map((e) => e.event_id)).size).toBe(2)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await refused()
  sink.setOffline(false)
  await app.relaunch()
  await refused()
  expect(
    (await readdir(app.dirs.userData, { recursive: true })).some((p) => /sentry[/\\]queue/.test(p))
  ).toBe(false)
  const again = await privacy(app)
  await again.click()
  await expect(again).toBeChecked()
  await refused()
  await expect.poll(() => sink.delivered.length).toBe(2)
  await app.relaunch({ DO_NOT_TRACK: '1' })
  await expect(await privacy(app)).toBeDisabled()
  await refused()
  await app.quit()
  const attempted = new Set(sink.events().map((event) => event.event_id))
  expect(attempted.size).toBe(3)
  expect(sink.delivered).toHaveLength(2)
  expect(sink.events().every((event) => event.fingerprint?.[0] === 'http_403')).toBe(true)
})

test('upgrade and main, renderer and child failures emit only allowlisted envelope data @smoke', async ({
  app,
  sink
}) => {
  await writeFile(
    join(app.dirs.userData, 'app-settings.json'),
    JSON.stringify({ speedUnit: 'bits' })
  )
  await app.launch()
  await finishWelcome(app.page)
  await expect(app.page.getByRole('dialog')).toHaveCount(0)
  expect(
    JSON.parse(await readFile(join(app.dirs.userData, 'app-settings.json'), 'utf8'))
  ).toMatchObject({ speedUnit: 'bits', v1ErrorReporting: true })
  // An unexpected exception inside a shipped main bundle, ahead of IPC serialization.
  await expect(app.api.startDownload(null!)).rejects.toThrow()
  await expect
    .poll(() => sink.events().some((e) => e.tags?.operation === 'startDownload'))
    .toBe(true)
  await verifyMaps(sink.events()[0])
  // Throw from the normal drop handler's call to DataTransfer.getData. Its real app frame
  // and Debug ID have to survive the renderer SDK, preload bridge and main sanitizer.
  await app.page.waitForFunction(() => '__SENTRY__RENDERER_INIT__' in window)
  await app.page.evaluate((message) => {
    const transfer = new DataTransfer()
    transfer.getData = () => {
      throw new TypeError(message)
    }
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer }))
  }, secret)
  await expect.poll(() => sink.events().some((e) => e.tags?.process === 'renderer')).toBe(true)
  await verifyMaps(sink.events().find((e) => e.tags?.process === 'renderer')!)

  await app.electronApp.evaluate(({ app }, message) => {
    app.emit('child-process-gone', {}, { reason: 'oom', type: 'Utility', serviceName: message })
  }, secret)
  await expect.poll(() => sink.events().some((e) => e.tags?.cause === 'process_oom')).toBe(true)

  // Exercise the SDK's real IPC surface, including renderer fields not scrubbed by beforeSend.
  await app.page.evaluate((secret) => {
    const ipc = (
      window as unknown as { __SENTRY_IPC__: Record<string, { sendEnvelope(body: string): void }> }
    ).__SENTRY_IPC__['sentry-ipc']
    const value = {
      message: 'ENOTFOUND ' + secret,
      extra: { secret },
      user: { email: secret },
      request: { url: secret },
      tags: { operation: secret },
      breadcrumbs: [{ message: secret }]
    }
    ipc.sendEnvelope(
      [
        JSON.stringify({ trace: { transaction: secret } }),
        '{"type":"event"}',
        JSON.stringify(value),
        JSON.stringify({ type: 'attachment', filename: secret, length: secret.length }),
        secret
      ].join('\n')
    )
    ipc.sendEnvelope(['{}', '{"type":"session"}', JSON.stringify({ sid: secret })].join('\n'))
  }, secret)
  await expect.poll(() => sink.events().some((e) => e.tags?.cause === 'dns')).toBe(true)
  await app.quit()
  expect(sink.bodies).toHaveLength(4)
  for (const body of sink.bodies) {
    for (const planted of [...canaries, app.dirs.userData, PROJECT_ROOT])
      expect(body).not.toContain(planted)
    const [header, item, payload, ...rest] = body.split('\n')
    expect(Object.keys(JSON.parse(header)).sort()).toEqual(['event_id', 'sent_at'])
    expect(JSON.parse(item)).toEqual({ type: 'event' })
    expect(rest).toEqual([])
    expect(JSON.parse(payload).sdk.settings.infer_ip).toBe('never')
  }
})

test('a refused adapter reports once while another finishes the download @smoke', async ({
  app,
  sink
}) => {
  test.skip(!LAN_ADDRESS, 'requires two local routes')
  const origin = await new Origin({ size: 24 * BLOCK, bytesPerSecond: 256 * 1024 }).start()
  try {
    await app.launch()
    await finishWelcome(app.page)
    await expect(app.page.getByRole('dialog')).toHaveCount(0)
    origin.setRule(({ range, from }) =>
      !isProbe(range) && from === '127.0.0.1' ? { status: 403 } : 'ok'
    )
    await app.start(origin.url('/secret-file-canary.zip?token=password-canary'), origin.sha256, {
      networks: ['a', 'b'],
      connections: 1
    })
    expect((await app.waitForStatus(['error', 'completed'])).status).toBe('completed')
    expect(sink.events().map((e) => [e.tags?.operation, e.fingerprint, e.level])).toEqual([
      ['network', ['http_403'], 'warning']
    ])
    expect(sink.bodies.join()).not.toContain('canary')
  } finally {
    await origin.stop()
  }
})

test('abrupt main exit is reported only on the next consenting launch @smoke', async ({
  app,
  sink
}) => {
  await app.launch()
  await finishWelcome(app.page)
  await expect(app.page.getByRole('dialog')).toHaveCount(0)
  await app.kill()
  await app.launch()
  await expect.poll(() => sink.events().map((e) => e.tags?.cause)).toEqual(['unclean_exit'])
  await app.relaunch()
  const toggle = await privacy(app)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await app.kill()
  await app.launch()
  await app.quit()
  expect(sink.events()).toHaveLength(1)
})

test('main exceptions, updater errors and no-space setup failures use the same project @smoke', async ({
  app,
  sink
}) => {
  await app.launch()
  await finishWelcome(app.page)
  await expect(app.page.getByRole('dialog')).toHaveCount(0)
  await app.electronApp.evaluate(({ app, dialog }, secret) => {
    // Keep the native fatal-error dialog from blocking the hidden test window.
    dialog.showErrorBox = () => {}
    process.emit('uncaughtException', new RangeError(secret))
    const requireApp = process
      .getBuiltinModule('node:module')
      .createRequire(app.getAppPath() + '/package.json')
    requireApp('electron-updater').autoUpdater.emit(
      'error',
      Object.assign(new Error(secret), { code: 'ENOTFOUND' })
    )
  }, secret)
  await expect(
    app.api.startDownload({
      kind: 'http',
      url: 'http://127.0.0.1/private-link-canary',
      destinationDir: app.dirs.dest,
      suggestedFileName: 'secret-file-canary.zip',
      supportsRanges: false,
      totalBytes: Number.MAX_SAFE_INTEGER,
      interfaceIds: ['a'],
      etag: null,
      lastModified: null
    })
  ).rejects.toThrow(/disk space/)
  await expect
    .poll(() =>
      sink
        .events()
        .map((e) => [e.tags?.operation, e.tags?.cause, e.level])
        .sort()
    )
    .toEqual([
      ['startDownload', 'no_space', 'warning'],
      ['unhandled', 'unexpected', 'fatal'],
      ['updater', 'dns', 'warning']
    ])
  expect(sink.bodies.join()).not.toContain('canary')
})

for (const step of ['repair', 'unpack'] as const) {
  test(`an NZB ${step} failure reports once even when the files stay available`, async ({
    app,
    sink
  }) => {
    const files = [{ name: 'secret-file-canary.zip', data: Buffer.alloc(2048) }]
    if (step === 'repair') files.push({ name: 'release.par2', data: Buffer.alloc(32) })
    const server = await new NewsServer({
      files,
      articleBytes: 1024,
      missing: (a) => step === 'repair' && a.file === 0 && a.number === 1
    }).start()
    try {
      await app.launch()
      await finishWelcome(app.page)
      await expect(app.page.getByRole('dialog')).toHaveCount(0)
      await app.api.saveUsenetServer({
        host: '127.0.0.1',
        port: server.port,
        tls: false,
        username: '',
        password: '',
        connections: 1
      })
      const path = join(app.dirs.userData, 'private-link-canary.nzb')
      await writeFile(path, server.nzb())
      await app.start(path, server.expectedSha())
      await app.waitForStatus(['completed', 'error'])
      await expect
        .poll(() => sink.events().map((e) => [e.tags?.operation, e.level]))
        .toEqual([[step, 'warning']])
      expect(sink.bodies.join()).not.toContain('canary')
    } finally {
      await server.stop()
    }
  })
}

test('failure publishing a completed file preserves the original error and UI outcome', async ({
  app,
  sink
}) => {
  const origin = await new Origin({ size: BLOCK }).start()
  try {
    await app.launch()
    await finishWelcome(app.page)
    await expect(app.page.getByRole('dialog')).toHaveCount(0)
    await app.electronApp.evaluate((_electron, message) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const rename = fs.rename
      fs.rename = async (from, to) => {
        if (String(from).endsWith('.plexo'))
          throw Object.assign(new Error(message), { code: 'ENOSPC' })
        return rename(from, to)
      }
    }, secret)
    await app.start(origin.url(), origin.sha256)
    expect((await app.waitForStatus('error')).error).toBe(secret)
    await expect
      .poll(() => sink.events().map((e) => [e.tags?.operation, e.fingerprint]))
      .toEqual([['publish', ['no_space']]])
    expect(sink.bodies.join()).not.toContain('canary')
  } finally {
    await origin.stop()
  }
})

test('Finishing the welcome with Do Not Track saves the displayed off choice; unconfigured builds keep the bridge closed', async ({
  app,
  sink
}) => {
  await app.launch({ DO_NOT_TRACK: '1' })
  await app.page.getByRole('button', { name: 'Next' }).click()
  const toggle = app.page.getByRole('switch', { name: 'Send crash reports' })
  await expect(toggle).toBeDisabled()
  await expect(toggle).not.toBeChecked()
  await finishWelcome(app.page)
  await expect(app.page.getByRole('dialog')).toHaveCount(0)
  await app.relaunch({ DO_NOT_TRACK: '0', PLEXO_E2E_SENTRY_PORT: 'invalid-host:9000' })
  expect(await app.page.evaluate(() => window.plexo.initialState)).toMatchObject({
    v1ErrorReporting: false,
    reportingAvailability: 'unconfigured'
  })
  expect(await app.page.evaluate(() => '__SENTRY_IPC__' in window)).toBe(false)
  await expect(app.api.startDownload(null!)).rejects.toThrow()
  await app.quit()
  expect(sink.bodies).toEqual([])
})
