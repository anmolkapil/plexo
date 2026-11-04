import { createServer, type Server } from 'node:http'
import { connect as netConnect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NzbDownloadState, UsenetServerInput } from '../src/shared/types'
import type { Locator } from '@playwright/test'
import { expect, LAN_ADDRESS, test, type PlexoApp } from './fixtures'
import { NewsServer, type NewsServerOptions } from './newsServer'
import { seededBytes } from './origin'

// Downloading from Usenet: an NZB's articles fetched from a local news server (newsServer.ts),
// decoded and written into their files byte for byte, over every network in use, through the
// faults a real server has. The checks fixture verifies each finished download's folder.

const KB = 1024

const RELEASE = [
  { name: 'Test.Release.part1.rar', data: seededBytes(200 * KB, 41) },
  { name: 'Test.Release.part2.rar', data: seededBytes(90 * KB + 7, 42) },
  { name: 'Test.Release.par2', data: seededBytes(3 * KB + 1, 43) }
]

let servers: NewsServer[] = []
let folder: string
test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'plexo-nzb-'))
})
test.afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()))
  servers = []
  await rm(folder, { recursive: true, force: true })
})

async function newsServer(options: Partial<NewsServerOptions> = {}): Promise<NewsServer> {
  const server = await new NewsServer({ files: RELEASE, ...options }).start()
  servers.push(server)
  return server
}

/** The server's NZB, saved where a browser would have put it. */
async function nzbOnDisk(server: NewsServer, name = 'Test.Release.nzb'): Promise<string> {
  const path = join(folder, name)
  await writeFile(path, server.nzb())
  return path
}

async function useServer(
  plexo: PlexoApp,
  server: NewsServer,
  settings: Partial<UsenetServerInput> = {}
): Promise<void> {
  await plexo.api.saveUsenetServer({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    username: '',
    password: '',
    connections: 4,
    ...settings
  })
}

test.describe('NZB downloads', () => {
  test('an NZB’s files, decoded byte for byte into their folder @smoke', async ({ plexo }) => {
    const server = await newsServer()
    await useServer(plexo, server)

    const id = await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.id).toBe(id)
    expect(done.fileName).toBe('Test.Release')
    expect(done.server).toBe('127.0.0.1')
    expect(done.totalBlocks).toBe(server.articleCount)
    expect(done.missingBytes).toBe(0)
    // Every file cut to its real size, which only the articles knew.
    expect(done.nzbFiles.map((file) => [file.name, file.size])).toEqual(
      RELEASE.map((file) => [file.name, file.data.length])
    )
    expect(new Set(server.served.map((article) => article.messageId)).size).toBe(
      server.articleCount
    )
  })

  test('an indexer’s NZB link is downloaded and named from its headers @smoke', async ({
    plexo
  }) => {
    const server = await newsServer()
    await useServer(plexo, server)
    const indexer: Server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/x-nzb',
        'Content-Disposition': 'attachment; filename="Indexer.Release.nzb"'
      })
      response.end(server.nzb())
    })
    await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = indexer.address() as AddressInfo
      const link = `http://127.0.0.1:${port}/api?t=get&id=1&apikey=secret`
      const probe = await plexo.api.probeUrl(link)
      expect(probe.kind).toBe('nzb')
      expect(probe.suggestedFileName).toBe('Indexer.Release')

      await plexo.start(link, server.expectedSha())
      const done = await plexo.waitForNzbStatus('completed', 30_000)
      expect(done.fileName).toBe('Indexer.Release')
    } finally {
      indexer.close()
    }
  })

  test('an indexer’s answer in plain XML: an NZB is taken, its error is shown', async ({
    plexo
  }) => {
    const server = await newsServer()
    await useServer(plexo, server)
    const indexer: Server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' })
      response.end(
        request.url?.includes('id=limit')
          ? '<?xml version="1.0" encoding="UTF-8"?>\n<error code="500" description="Request limit reached"/>'
          : server.nzb()
      )
    })
    await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = indexer.address() as AddressInfo
      await expect(
        plexo.api.probeUrl(`http://127.0.0.1:${port}/api?t=get&id=limit&apikey=secret`)
      ).rejects.toThrow(/The indexer refused this link: Request limit reached \(error 500\)/)
      const probe = await plexo.api.probeUrl(
        `http://127.0.0.1:${port}/api?t=get&id=1&apikey=secret`
      )
      expect(probe.kind).toBe('nzb')
    } finally {
      indexer.close()
    }
  })

  test('articles the server doesn’t have are left as gaps, and counted', async ({ plexo }) => {
    const server = await newsServer({
      missing: (article) => article.file === 0 && (article.number === 3 || article.number === 7)
    })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[0].missing).toBe(2)
    expect(done.missingBytes).toBeGreaterThan(0)
    expect(done.blocks.filter((block) => block.status === 'missing')).toHaveLength(2)
    // Asked for once: a missing article doesn't turn up by asking again.
    const asked = server.served.filter((article) => article.fault === 'missing')
    expect(asked).toHaveLength(2)
  })

  test('a server with none of the articles fails the download, leaving nothing', async ({
    plexo
  }) => {
    const server = await newsServer({ missing: () => true })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const failed = await plexo.waitForNzbStatus('error', 30_000)
    expect(failed.error).toMatch(/none of this NZB’s articles/)
    expect(failed.resumable).toBe(false)
  })

  test('a damaged article is fetched again; one damaged every time counts as missing', async ({
    plexo
  }) => {
    const server = await newsServer({
      fault: (article, request) =>
        article.file === 1 && article.number === 2 && request === 1
          ? 'corrupt'
          : article.file === 0 && article.number === 5
            ? 'corrupt'
            : 'ok'
    })
    await useServer(plexo, server)

    // The article damaged every time is a gap in its file.
    const expected = server.expectedSha((article) => article.file === 0 && article.number === 5)
    await plexo.start(await nzbOnDisk(server), expected)
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[1].missing).toBe(0)
    expect(done.nzbFiles[0].missing).toBe(1)
    const fetches = (file: number, number: number): number =>
      server.served.filter(
        (article) =>
          article.messageId.startsWith(`part${number}of`) && article.messageId.includes(`.${file}.`)
      ).length
    expect(fetches(1, 2)).toBe(2)
    expect(fetches(0, 5)).toBe(2)
  })

  test('connections dropped or stalled mid-article are opened again', async ({ plexo }) => {
    const server = await newsServer({
      fault: (article, request) =>
        request > 1 ? 'ok' : article.number === 2 ? 'cut' : article.number === 4 ? 'stall' : 'ok'
    })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.missingBytes).toBe(0)
    expect(done.networks[0].retries).toBeGreaterThan(0)
  })

  test('signs in, and says so when the password is wrong', async ({ plexo }) => {
    const server = await newsServer({ username: 'reader', password: 'right' })
    await useServer(plexo, server, { username: 'reader', password: 'wrong' })
    await expect(
      plexo.api.testUsenetServer({
        host: '127.0.0.1',
        port: server.port,
        tls: false,
        username: 'reader',
        connections: 4
      })
    ).rejects.toThrow(/username or password/)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const failed = await plexo.waitForNzbStatus('error', 30_000)
    expect(failed.error).toMatch(/username or password/)
    expect(failed.resumable).toBe(true)

    // Fixed in the settings, the same download resumes and finishes.
    await useServer(plexo, server, { username: 'reader', password: 'right' })
    await plexo.api.resumeDownload(failed.id)
    await plexo.waitForNzbStatus('completed', 30_000)
  })

  test('a wrong password is put right from the failed download, then it starts again', async ({
    plexo,
    dirs
  }) => {
    const server = await newsServer({ username: 'reader', password: 'right' })
    await useServer(plexo, server, { username: 'reader', password: 'wrong' })
    const nzb = await nzbOnDisk(server)
    await plexo.start(nzb, server.expectedSha())
    const failed = await plexo.waitForNzbStatus('error', 30_000)
    plexo.tracked.delete(failed.id)

    const { page } = plexo
    await page.getByText('Test.Release', { exact: true }).first().click()
    await page.getByRole('button', { name: /^Usenet server 127\.0\.0\.1/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Usenet server' })
    await expect(dialog.getByLabel('Password')).toHaveAttribute('placeholder', 'Saved')
    await dialog.getByLabel('Password').fill('right')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()

    // Nothing of it came in, so it starts over from its NZB, as any such download does.
    await page.getByRole('button', { name: 'Download again' }).click()
    await expect(page.getByRole('textbox', { name: 'Link' })).toHaveValue(nzb)
    // Saved where the test looks, as the folder picker would choose it.
    await plexo.evaluateMain(({ dialog }, dest) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
    }, dirs.dest)
    await page
      .getByText('Save to', { exact: true })
      .locator('..')
      .getByRole('button', { name: 'Change' })
      .click()
    // The failed one is gone by now: the new one is what the folder gains.
    await plexo.expectNextDownload(server.expectedSha())
    await expect(page.getByText('127.0.0.1', { exact: false }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Download', exact: true }).click()
    await plexo.waitForNzbStatus('completed', 30_000)
  })

  test('a server that turns every connection away is unreachable, not a strike', async ({
    plexo
  }) => {
    const server = await newsServer()
    const { port } = server
    await server.stop()
    servers = []
    await useServer(plexo, server, { port })

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    // Shown as it is for an HTTP server out of reach: one connection keeps trying, backing off.
    await plexo.waitUntil(
      (state) =>
        state.kind === 'nzb' &&
        state.networks.find((network) => network.id === 'a')?.status === 'unreachable',
      15_000
    )
  })

  test('never more connections than the account allows', async ({ plexo }) => {
    const server = await newsServer({ maxConnections: 2, delayMs: 5 })
    // Set to more than the account has: the server turns the rest away.
    await useServer(plexo, server, { connections: 6 })

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(server.refused).toBeGreaterThan(0)
    expect(done.missingBytes).toBe(0)
  })

  test('without a news server set up, it says so before starting', async ({ plexo }) => {
    const server = await newsServer()
    const probe = await plexo.api.probeUrl(await nzbOnDisk(server))
    expect(probe.kind).toBe('nzb')
    expect(await plexo.api.usenetServer()).toBeNull()
    await expect(plexo.start(await nzbOnDisk(server), server.expectedSha())).rejects.toThrow(
      /Set up a news server/
    )
  })

  test('pause, quit, relaunch and resume: articles already in aren’t fetched again', async ({
    plexo
  }) => {
    const server = await newsServer({ delayMs: 40 })
    await useServer(plexo, server, { connections: 2 })

    const id = await plexo.start(await nzbOnDisk(server), server.expectedSha())
    await plexo.waitUntil((state) => state.kind === 'nzb' && countDone(state) >= 4)
    await plexo.api.pauseDownload(id)
    const paused = await plexo.waitForNzbStatus('paused')
    const doneBefore = paused.blocks.filter((block) => block.status === 'completed').length

    await plexo.relaunch()
    // No keychain on a test runner: an account without a password is what survives a relaunch.
    expect((await plexo.api.usenetServer())?.host).toBe('127.0.0.1')
    const servedBefore = server.served.length
    await plexo.api.resumeDownload(id)
    await plexo.waitForNzbStatus('completed', 30_000)
    expect(server.served.length - servedBefore).toBeLessThanOrEqual(
      server.articleCount - doneBefore + 2
    )
  })

  test('goes through the proxy set on the network', async ({ plexo }) => {
    const server = await newsServer()
    await useServer(plexo, server, { connections: 2 })
    // SOCKS5 without auth, IPv4 targets only: greeting, then CONNECT.
    const targets: string[] = []
    const proxy = createTcpServer((client) => {
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x00]))
        client.once('data', (request: Buffer) => {
          const host = [...request.subarray(4, 8)].join('.')
          const port = request.readUInt16BE(8)
          targets.push(`${host}:${port}`)
          const upstream = netConnect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            upstream.pipe(client)
            client.pipe(upstream)
          })
          upstream.on('error', () => client.destroy())
          client.on('error', () => upstream.destroy())
        })
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const port = (proxy.address() as AddressInfo).port
      await plexo.api.updateSettings({
        networkPreferences: {
          a: { proxy: { enabled: true, type: 'socks5', host: '127.0.0.1', port } }
        }
      })
      await plexo.start(await nzbOnDisk(server), server.expectedSha())
      await plexo.waitForNzbStatus('completed', 30_000)
      expect(targets.length).toBeGreaterThan(0)
      expect(new Set(targets)).toEqual(new Set([`127.0.0.1:${server.port}`]))
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  test('shares the connections across both networks', async ({ plexo }) => {
    test.skip(!LAN_ADDRESS, 'needs a second local address')
    const server = await newsServer({ delayMs: 5 })
    await useServer(plexo, server, { connections: 4 })

    await plexo.start(await nzbOnDisk(server), server.expectedSha(), { networks: ['a', 'b'] })
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    const from = new Set(server.served.map((article) => article.from))
    expect(from).toEqual(new Set(['127.0.0.1', LAN_ADDRESS]))
    for (const network of done.networks.filter((network) => network.enabled)) {
      expect(network.bytesDownloaded).toBeGreaterThan(0)
    }
  })
})

async function useBackup(
  plexo: PlexoApp,
  server: NewsServer,
  settings: Partial<UsenetServerInput> = {}
): Promise<void> {
  await plexo.api.saveUsenetBackup({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    username: '',
    password: '',
    connections: 2,
    ...settings
  })
}

/** The articles a server was asked for, by message ID. */
const askedFor = (server: NewsServer): Set<string> =>
  new Set(server.served.map((article) => article.messageId))

test.describe('Backup news server', () => {
  const lacking = (article: { file: number; number: number }): boolean =>
    article.file === 0 && (article.number === 3 || article.number === 7)

  test('articles the news server doesn’t have come from the backup server', async ({ plexo }) => {
    const main = await newsServer({ missing: lacking })
    const backup = await newsServer()
    await useServer(plexo, main)
    await useBackup(plexo, backup)

    // Nothing missing in the end: the backup server filled the gaps.
    await plexo.start(
      await nzbOnDisk(main),
      main.expectedSha(() => false)
    )
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.missingBytes).toBe(0)
    expect(done.fromBackup).toBe(2)
    expect(done.backupError).toBeUndefined()
    // Only what the news server lacked was asked of the backup.
    expect(backup.served.every((article) => article.fault === 'ok')).toBe(true)
    expect(askedFor(backup).size).toBe(2)
  })

  test('an article neither server has counts as missing', async ({ plexo }) => {
    const main = await newsServer({ missing: lacking })
    const backup = await newsServer({
      missing: (article) => article.file === 0 && article.number === 7
    })
    await useServer(plexo, main)
    await useBackup(plexo, backup)

    const expected = main.expectedSha((article) => article.file === 0 && article.number === 7)
    await plexo.start(await nzbOnDisk(main), expected)
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[0].missing).toBe(1)
    expect(done.fromBackup).toBe(1)
    expect(done.blocks.filter((block) => block.status === 'missing')).toHaveLength(1)
  })

  test('the backup server isn’t connected to while nothing is missing', async ({ plexo }) => {
    const main = await newsServer()
    const backup = await newsServer()
    await useServer(plexo, main)
    await useBackup(plexo, backup)

    await plexo.start(await nzbOnDisk(main), main.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.fromBackup).toBeUndefined()
    expect(backup.connections).toBe(0)
  })

  test('a backup server out of reach leaves the articles missing, and the download finishes', async ({
    plexo
  }) => {
    const main = await newsServer({ missing: lacking })
    const backup = await newsServer()
    const { port } = backup
    await backup.stop()
    servers = servers.filter((server) => server !== backup)
    await useServer(plexo, main)
    await useBackup(plexo, backup, { port })

    await plexo.start(await nzbOnDisk(main), main.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[0].missing).toBe(2)
    expect(done.backupError).toMatch(/backup server couldn’t be reached/)
  })

  test('a backup server that turns the sign-in down leaves the articles missing', async ({
    plexo
  }) => {
    const main = await newsServer({ missing: lacking })
    const backup = await newsServer({ username: 'reader', password: 'right' })
    await useServer(plexo, main)
    await useBackup(plexo, backup, { username: 'reader', password: 'right' })
    // Tested with the backup's saved password, not the news server's.
    const input = { host: '127.0.0.1', port: backup.port, tls: false, username: 'reader' }
    await plexo.api.testUsenetServer({ ...input, connections: 2 }, true)
    await expect(plexo.api.testUsenetServer({ ...input, connections: 2 })).rejects.toThrow(
      /username or password/
    )

    await useBackup(plexo, backup, { username: 'reader', password: 'wrong' })
    await plexo.start(await nzbOnDisk(main), main.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[0].missing).toBe(2)
    expect(done.backupError).toMatch(/didn’t accept the username or password/)
  })
})

/** Speed & data limits, on its Usenet page. */
async function openUsenetPage(plexo: PlexoApp): Promise<Locator> {
  await plexo.page.getByRole('button', { name: /^\d+ networks?/ }).click()
  await plexo.page.getByRole('button', { name: 'Speed & data limits', exact: true }).click()
  const dialog = plexo.page.getByRole('dialog', { name: 'Speed & data limits' })
  await dialog.getByRole('button', { name: /^Usenet/ }).click()
  return dialog
}

/** An indexer answering every request with `server`'s NZB, as an NZB. */
async function indexerFor(server: NewsServer): Promise<{ link: string; close: () => void }> {
  const indexer: Server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/x-nzb',
      'Content-Disposition': 'attachment; filename="Indexer.Release.nzb"'
    })
    response.end(server.nzb())
  })
  await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve))
  const { port } = indexer.address() as AddressInfo
  return { link: `http://127.0.0.1:${port}/api?t=get&id=1`, close: () => indexer.close() }
}

test.describe('Usenet settings', () => {
  test('the switch in Speed & data limits is saved with the server and kept on restart', async ({
    plexo
  }) => {
    const server = await newsServer()
    // Saved before there was a switch: on.
    await writeFile(
      join(plexo.dirs.userData, 'usenet-server.json'),
      JSON.stringify({ host: '127.0.0.1', port: server.port, tls: false, connections: 3 })
    )
    await plexo.relaunch()
    expect((await plexo.api.usenetServer())?.enabled).toBe(true)

    let dialog = await openUsenetPage(plexo)
    await expect(dialog.getByText(`127.0.0.1:${server.port}`)).toBeVisible()
    await dialog.getByRole('switch', { name: 'Usenet downloads' }).click()
    // Nothing changes until Save.
    expect((await plexo.api.usenetServer())?.enabled).toBe(true)
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(await plexo.api.usenetServer()).toMatchObject({ enabled: false, connections: 3 })

    await plexo.relaunch()
    expect((await plexo.api.usenetServer())?.enabled).toBe(false)
    dialog = await openUsenetPage(plexo)
    await expect(dialog.getByRole('switch', { name: 'Usenet downloads' })).not.toBeChecked()
    // Saving the server from its own form leaves the switch as it is.
    await dialog.getByRole('button', { name: 'Change server' }).click()
    const form = plexo.page.getByRole('dialog', { name: 'Usenet server' })
    await form.getByLabel('Connections').fill('5')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden()
    expect(await plexo.api.usenetServer()).toMatchObject({ enabled: false, connections: 5 })
  })

  test('off, an NZB is no Usenet download, and a running one stops connecting', async ({
    plexo
  }) => {
    const server = await newsServer({ delayMs: 40 })
    await useServer(plexo, server, { connections: 2 })
    const nzb = await nzbOnDisk(server)
    const id = await plexo.start(nzb, server.expectedSha())
    await plexo.waitUntil((state) => state.kind === 'nzb' && countDone(state) >= 2)

    await useServer(plexo, server, { connections: 2, enabled: false })
    const failed = await plexo.waitForNzbStatus('error', 10_000)
    expect(failed.error).toMatch(/Usenet downloads are off/)
    expect(failed.resumable).toBe(true)
    // Resumed while off, it fails again before it connects.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const served = server.served.length
    await plexo.api.resumeDownload(id)
    await expect.poll(async () => (await plexo.byId(id))?.status, { timeout: 10_000 }).toBe('error')
    expect((await plexo.byId(id))?.error).toMatch(/Usenet downloads are off/)
    expect(server.served.length).toBe(served)

    // An NZB file can't be downloaded; one by link is a plain file, for another newsreader.
    await expect(plexo.api.probeUrl(nzb)).rejects.toThrow(/Usenet downloads are off/)
    const indexer = await indexerFor(server)
    try {
      const probe = await plexo.api.probeUrl(indexer.link)
      expect(probe.kind).toBe('http')
      expect(probe.suggestedFileName).toBe('Indexer.Release.nzb')
    } finally {
      indexer.close()
    }

    // Back on, the download picks up where it stopped.
    await useServer(plexo, server, { connections: 2, enabled: true })
    await plexo.api.resumeDownload(id)
    await plexo.waitForNzbStatus('completed', 30_000)
  })

  test('the news server is set up from Speed & data limits', async ({ plexo }) => {
    const server = await newsServer()
    const dialog = await openUsenetPage(plexo)
    await expect(dialog.getByText('No news server set up')).toBeVisible()
    await expect(dialog.getByRole('switch', { name: 'Usenet downloads' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Set up server' }).click()

    const form = plexo.page.getByRole('dialog', { name: 'Usenet server' })
    await form.getByLabel('Server').fill('127.0.0.1')
    await form.getByRole('switch').click()
    await form.getByLabel('Port').fill(String(server.port))
    await form.getByLabel('Connections').fill('2')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden()

    await expect(dialog.getByText(`127.0.0.1:${server.port}`)).toBeVisible()
    await expect(dialog.getByRole('switch', { name: 'Usenet downloads' })).toBeChecked()
    // Saved already: the server's own Save is what counts, not Cancel here.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(await plexo.api.usenetServer()).toMatchObject({
      enabled: true,
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      connections: 2
    })
    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    await plexo.waitForNzbStatus('completed', 30_000)
  })
})

test.describe('Backup server settings', () => {
  test('set up from the Usenet page, kept on restart, and an older file still loads', async ({
    plexo
  }) => {
    const main = await newsServer()
    const backup = await newsServer()
    const file = join(plexo.dirs.userData, 'usenet-server.json')
    // Saved before there was a backup server.
    await writeFile(
      file,
      JSON.stringify({ host: '127.0.0.1', port: main.port, tls: false, connections: 3 })
    )
    await plexo.relaunch()
    expect(await plexo.api.usenetServer()).toMatchObject({ host: '127.0.0.1', connections: 3 })
    expect((await plexo.api.usenetServer())?.backup).toBeUndefined()

    const dialog = await openUsenetPage(plexo)
    await dialog.getByRole('button', { name: 'Set up backup server' }).click()
    const form = plexo.page.getByRole('dialog', { name: 'Backup server' })
    await form.getByLabel('Server').fill('127.0.0.1')
    await form.getByRole('switch').click()
    await form.getByLabel('Port').fill(String(backup.port))
    await form.getByLabel('Connections').fill('2')
    await form.getByRole('button', { name: 'Test' }).click()
    await expect(form.getByText('Connected and signed in.')).toBeVisible()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden()
    await expect(dialog.getByText(`127.0.0.1:${backup.port}`)).toBeVisible()

    // Saving the news server from its own form keeps the backup.
    await dialog.getByRole('button', { name: 'Change server' }).click()
    const mainForm = plexo.page.getByRole('dialog', { name: 'Usenet server' })
    await mainForm.getByLabel('Connections').fill('5')
    await mainForm.getByRole('button', { name: 'Save' }).click()
    await expect(mainForm).toBeHidden()
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await plexo.relaunch()
    expect(await plexo.api.usenetServer()).toMatchObject({
      enabled: true,
      port: main.port,
      connections: 5,
      backup: { host: '127.0.0.1', port: backup.port, tls: false, connections: 2 }
    })
  })

  test('the backup server is removed from the Usenet page', async ({ plexo }) => {
    const main = await newsServer()
    const backup = await newsServer()
    await useServer(plexo, main)
    await useBackup(plexo, backup)

    const dialog = await openUsenetPage(plexo)
    await expect(dialog.getByText(`127.0.0.1:${backup.port}`)).toBeVisible()
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await plexo.page
      .getByRole('alertdialog', { name: 'Remove the backup server?' })
      .getByRole('button', { name: 'Remove' })
      .click()
    await expect(dialog.getByText(`127.0.0.1:${backup.port}`)).toBeHidden()
    await expect(dialog.getByRole('button', { name: 'Set up backup server' })).toBeVisible()
    expect((await plexo.api.usenetServer())?.backup).toBeUndefined()
    expect(await plexo.api.usenetServer()).toMatchObject({ port: main.port })
  })
})

function countDone(state: NzbDownloadState): number {
  return state.blocks.filter((block) => block.status === 'completed').length
}
