import { execFileSync, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect as netConnect, createServer as createTcpServer, type AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NzbDownloadState, UsenetServerInput } from '../src/shared/types'
import { expect, LAN_ADDRESS, PROJECT_ROOT, test, treeSha, type PlexoApp } from './fixtures'
import { NewsServer, type NewsFile, type NewsServerOptions } from './newsServer'
import { seededBytes } from './origin'

// Downloading from Usenet: an NZB's articles fetched from a local news server (newsServer.ts),
// decoded and written into their files byte for byte, over every network in use, through the
// faults a real server has. The checks fixture verifies each finished download's folder.

const KB = 1024

// Neither archives nor .par2 files: what these download is checked as it was posted, whatever
// tools the computer has (repairing and unpacking are tested on their own, at the end).
const RELEASE = [
  { name: 'Test.Release.part1.bin', data: seededBytes(200 * KB, 41) },
  { name: 'Test.Release.part2.bin', data: seededBytes(90 * KB + 7, 42) },
  { name: 'Test.Release.txt', data: seededBytes(3 * KB + 1, 43) }
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

function countDone(state: NzbDownloadState): number {
  return state.blocks.filter((block) => block.status === 'completed').length
}

// Repairing and unpacking, with the tools installed where the tests run: each test skips itself
// without the ones it needs (GitHub's Linux runners have 7-Zip, not par2).

const installed = (tool: string): boolean =>
  spawnSync(tool, ['--help'], { stdio: 'ignore' }).error === undefined
const SEVEN_ZIP = ['7z', '7zz'].find(installed)
const PAR2 = installed('par2')

const CONTENT = [
  { path: 'movie.mkv', data: seededBytes(150 * KB + 3, 51) },
  { path: 'info.txt', data: seededBytes(2 * KB, 52) }
]

/** What a poster uploads: CONTENT, packed (and given .par2 files) by `make` in a folder of its
 * own, every file there. */
async function posted(
  make: (run: (tool: string, args: string[]) => void) => void
): Promise<NewsFile[]> {
  const dir = join(folder, 'posted')
  await mkdir(dir)
  for (const file of CONTENT) await writeFile(join(dir, file.path), file.data)
  make((tool, args) => execFileSync(tool, args, { cwd: dir, stdio: 'ignore' }))
  for (const file of CONTENT) await rm(join(dir, file.path))
  const names = await readdir(dir)
  return Promise.all(names.map(async (name) => ({ name, data: await readFile(join(dir, name)) })))
}

const twoGaps = (article: { file: number; number: number }): boolean =>
  article.file === 0 && (article.number === 2 || article.number === 5)

test.describe('NZB repair and unpacking', () => {
  test('gaps are repaired with the .par2 files, then the archive is unpacked and tidied away', async ({
    plexo
  }) => {
    test.skip(!PAR2 || !SEVEN_ZIP, 'needs par2 and 7-Zip')
    const files = await posted((run) => {
      run(SEVEN_ZIP!, ['a', '-mx0', 'Test.Release.7z', 'movie.mkv', 'info.txt'])
      run('par2', ['c', '-s16384', '-r40', '-n2', 'Test.Release.par2', 'Test.Release.7z'])
    })
    // The archive first, so the gaps are in it.
    files.sort((a, b) => Number(a.name.endsWith('.par2')) - Number(b.name.endsWith('.par2')))
    const server = await newsServer({ files, missing: twoGaps })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), treeSha(CONTENT))
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.nzbFiles[0].missing).toBe(2)
    expect(done.postProcess).toMatchObject({ repaired: true, unpacked: true })
    expect(done.postProcess?.unpackedFiles?.sort()).toEqual(['info.txt', 'movie.mkv'])

    await plexo.page.getByText('Test.Release', { exact: true }).first().click()
    await expect(
      plexo.page.getByText('2 missing articles repaired with the .par2 files, then unpacked.')
    ).toBeVisible()
  })

  test('more gaps than the .par2 files can repair fail the download, saying so', async ({
    plexo
  }) => {
    test.skip(!PAR2, 'needs par2')
    const files = [
      { name: 'Test.Release.mkv', data: CONTENT[0].data },
      ...(await posted((run) =>
        run('par2', ['c', '-s16384', '-c1', '-n1', 'Test.Release.par2', 'movie.mkv'])
      ))
    ]
    const server = await newsServer({ files, missing: twoGaps })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const failed = await plexo.waitForNzbStatus('error', 30_000)
    expect(failed.error).toBe(
      '2 articles weren’t on the news server, more than the download’s .par2 files can repair.'
    )
  })

  test('a 7-Zip archive in volumes is unpacked, its volumes kept when the setting says so', async ({
    plexo
  }) => {
    test.skip(!SEVEN_ZIP, 'needs 7-Zip')
    const files = await posted((run) =>
      run(SEVEN_ZIP!, ['a', '-mx0', '-v60k', 'Test.Release.7z', 'movie.mkv', 'info.txt'])
    )
    expect(files.map((file) => file.name).sort()).toEqual([
      'Test.Release.7z.001',
      'Test.Release.7z.002',
      'Test.Release.7z.003'
    ])
    const server = await newsServer({ files })
    await useServer(plexo, server, { deleteArchives: false })

    const posts = files.map((file) => ({ path: file.name, data: file.data }))
    await plexo.start(await nzbOnDisk(server), treeSha([...CONTENT, ...posts]))
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.postProcess).toMatchObject({ unpacked: true })
  })

  test('a password-protected archive is left as posted, saying so', async ({ plexo }) => {
    test.skip(!SEVEN_ZIP, 'needs 7-Zip')
    const files = await posted((run) =>
      run(SEVEN_ZIP!, ['a', '-psecret', 'Test.Release.7z', 'movie.mkv', 'info.txt'])
    )
    const server = await newsServer({ files })
    await useServer(plexo, server)

    // 7-Zip writes what it can before it finds the password wrong: that goes again.
    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.postProcess?.unpacked).toBeUndefined()
    expect(done.postProcess?.note).toMatch(/Test\.Release\.7z is password-protected/)
  })
})

test.describe('NZB repair and unpacking without the tools', () => {
  // Nowhere to find them: they may be installed outside PATH elsewhere (see findTool).
  test.use({ appEnv: { PATH: join(tmpdir(), 'plexo-no-tools') } })

  test('completes, saying which tool to install', async ({ plexo }) => {
    test.skip(process.platform !== 'linux', 'looks outside PATH on Windows and macOS')
    const server = await newsServer({
      files: [
        { name: 'Test.Release.7z', data: seededBytes(40 * KB, 61) },
        { name: 'Test.Release.par2', data: seededBytes(KB, 62) }
      ],
      missing: (article) => article.file === 0 && article.number === 1
    })
    await useServer(plexo, server)

    await plexo.start(await nzbOnDisk(server), server.expectedSha())
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.postProcess?.missingTool).toBe('par2')
    await plexo.page.getByText('Test.Release', { exact: true }).first().click()
    await expect(
      plexo.page.getByText(/Install par2 \(par2cmdline\) and Plexo repairs downloads like this/)
    ).toBeVisible()
  })
})

/** Whether process `pid` is still running. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.describe('NZB unpacking, cancelled', () => {
  // A 7-Zip that prints how far it got, then waits to be killed (e2e/tools/slow/7z).
  const pidFile = join(tmpdir(), `plexo-slow-7z-${process.pid}.pid`)
  test.use({
    appEnv: { PATH: join(PROJECT_ROOT, 'e2e', 'tools', 'slow'), PLEXO_E2E_SLOW_TOOL_PID: pidFile }
  })

  test('shows the stage, and cancelling kills the tool', async ({ plexo }) => {
    test.skip(process.platform === 'win32', 'the stand-in is a shell script')
    const server = await newsServer({
      files: [{ name: 'Test.Release.7z', data: seededBytes(40 * KB, 71) }]
    })
    await useServer(plexo, server)

    const id = await plexo.start(await nzbOnDisk(server), server.expectedSha())
    await plexo.waitUntil(
      (state) => state.kind === 'nzb' && state.postProcess?.percent === 12,
      30_000
    )
    await plexo.page.getByText('Test.Release', { exact: true }).first().click()
    await expect(plexo.page.getByText('Unpacking… 12%')).toBeVisible()
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(alive(pid)).toBe(true)

    await plexo.api.cancelDownload(id)
    await plexo.waitForNzbStatus('cancelled', 10_000)
    await expect.poll(() => alive(pid)).toBe(false)
    await rm(pidFile, { force: true })
  })
})

test.describe('NZB unpacking, stopped by a quit', () => {
  const pidFile = join(tmpdir(), `plexo-slow-7z-quit-${process.pid}.pid`)
  test.use({
    appEnv: { PATH: join(PROJECT_ROOT, 'e2e', 'tools', 'slow'), PLEXO_E2E_SLOW_TOOL_PID: pidFile }
  })

  test('the tool goes with Plexo, and the download unpacks on Resume', async ({ plexo }) => {
    test.skip(process.platform === 'win32' || !SEVEN_ZIP, 'needs 7-Zip and a shell')
    const files = await posted((run) =>
      run(SEVEN_ZIP!, ['a', '-mx0', 'Test.Release.7z', 'movie.mkv', 'info.txt'])
    )
    const server = await newsServer({ files })
    await useServer(plexo, server)

    const id = await plexo.start(await nzbOnDisk(server), treeSha(CONTENT))
    await plexo.waitUntil(
      (state) => state.kind === 'nzb' && state.postProcess?.percent === 12,
      30_000
    )
    const pid = Number(await readFile(pidFile, 'utf8'))
    await plexo.quit()
    expect(alive(pid)).toBe(false)
    await rm(pidFile, { force: true })

    // Not done, so not completed: it waits for Resume, with the real 7-Zip this time.
    await plexo.relaunch({ PATH: process.env.PATH ?? '' })
    const paused = await plexo.waitForNzbStatus('paused')
    expect(paused.postProcess?.stage).toBe('unpacking')
    await plexo.api.resumeDownload(id)
    const done = await plexo.waitForNzbStatus('completed', 30_000)
    expect(done.postProcess).toMatchObject({ unpacked: true })
  })
})
