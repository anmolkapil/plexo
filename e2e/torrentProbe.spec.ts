import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { Torrent } from 'webtorrent'
import { expect, test } from './fixtures'
import { seededBytes } from './origin'

// Getting a torrent in: every way in gives the same answer, and a torrent Plexo can't save
// safely is refused before anything is written. Peers come from the link itself (x.pe), so no
// tracker or DHT is involved.

// ESM-only: specs are compiled to CommonJS, so these come in through import().
const loadWebTorrent = (): Promise<typeof WebTorrent> =>
  import('webtorrent').then((module) => module.default)
const loadBencode = (): Promise<{ encode: (value: unknown) => Uint8Array }> =>
  import('bencode' as string).then((module) => module.default)

const quiet = { dht: false, lsd: false, tracker: false, natUpnp: false, natPmp: false, utp: false }

function named(data: Buffer, name: string): Buffer {
  return Object.assign(data, { name })
}

/** A client seeding `files` (one file, or a folder of them when `folder` is given). */
async function seed(
  files: Buffer[],
  folder?: string
): Promise<{ client: WebTorrent; torrent: Torrent }> {
  const client = new (await loadWebTorrent())(quiet)
  const torrent = await new Promise<Torrent>((resolve) =>
    client.seed(files.length === 1 ? files[0] : files, { name: folder, announce: [] }, resolve)
  )
  return { client, torrent }
}

/** Serves `body` at /file.torrent as a torrent. */
async function serveTorrent(body: Uint8Array): Promise<{ url: string; server: Server }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-bittorrent' })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.torrent`, server }
}

const clients: WebTorrent[] = []
const servers: Server[] = []
test.afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => new Promise((done) => client.destroy(done))))
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
})

test.describe('getting a torrent in', () => {
  test('a link to a .torrent', async ({ plexo }) => {
    const { client, torrent } = await seed([named(seededBytes(300_000, 1), 'movie.mkv')])
    clients.push(client)
    const { url, server } = await serveTorrent(torrent.torrentFile)
    servers.push(server)

    const probe = await plexo.api.probeUrl(url)
    expect(probe.kind).toBe('torrent')
    if (probe.kind !== 'torrent') throw new Error('Expected torrent metadata')
    expect(probe.torrent.infoHash).toBe(torrent.infoHash)
    expect(probe.suggestedFileName).toBe('movie.mkv')
    expect(probe.totalBytes).toBe(300_000)
    expect(probe.torrent.files).toEqual([{ path: 'movie.mkv', length: 300_000 }])
  })

  test('a .torrent file on this computer, with a folder of files', async ({ plexo }) => {
    const { client, torrent } = await seed(
      [named(seededBytes(1000, 2), 'a.bin'), named(seededBytes(2000, 3), 'b.bin')],
      'Album'
    )
    clients.push(client)
    const path = join(await mkdtemp(join(tmpdir(), 'plexo-torrent-')), 'album.torrent')
    await writeFile(path, torrent.torrentFile)

    const probe = await plexo.api.probeUrl(path)
    expect(probe.kind).toBe('torrent')
    if (probe.kind !== 'torrent') throw new Error('Expected torrent metadata')
    expect(probe.suggestedFileName).toBe('Album')
    expect(probe.totalBytes).toBe(3000)
    expect(probe.torrent.files.map((file) => file.path.replace(/\\/g, '/')).sort()).toEqual([
      'Album/a.bin',
      'Album/b.bin'
    ])
  })

  test('a magnet link, its details fetched from a peer', async ({ plexo }) => {
    const { client, torrent } = await seed([named(seededBytes(500_000, 4), 'show.mp4')])
    clients.push(client)
    const magnet = `${torrent.magnetURI}&x.pe=127.0.0.1:${client.address().port}`

    const probe = await plexo.api.probeUrl(magnet)
    expect(probe.kind).toBe('torrent')
    if (probe.kind !== 'torrent') throw new Error('Expected torrent metadata')
    expect(probe.torrent.infoHash).toBe(torrent.infoHash)
    expect(probe.suggestedFileName).toBe('show.mp4')
    expect(probe.totalBytes).toBe(500_000)
  })

  test('two files that would be saved as one are refused', async ({ plexo }) => {
    const { client, torrent } = await seed(
      [named(seededBytes(10, 5), 'Read.txt'), named(seededBytes(10, 6), 'read.txt')],
      'Docs'
    )
    clients.push(client)
    const { url, server } = await serveTorrent(torrent.torrentFile)
    servers.push(server)

    await expect(plexo.api.probeUrl(url)).rejects.toThrow(/saved as the same file/)
  })

  test('a v2-only torrent is refused', async ({ plexo }) => {
    // BEP 52: a file tree and per-file piece roots, but none of the v1 piece hashes.
    const v2Only = (await loadBencode()).encode({
      info: {
        name: 'new.bin',
        'piece length': 16384,
        'meta version': 2,
        'file tree': { 'new.bin': { '': { length: 1, 'pieces root': Buffer.alloc(32) } } }
      }
    })
    const { url, server } = await serveTorrent(v2Only)
    servers.push(server)

    await expect(plexo.api.probeUrl(url)).rejects.toThrow(/BitTorrent v2 only/)
  })

  test('a magnet link with only an xs= source, its details fetched over HTTP', async ({
    plexo
  }) => {
    const { client, torrent } = await seed([named(seededBytes(200_000, 7), 'notes.pdf')])
    // Only the .torrent is served; the seeding client takes no part.
    await new Promise((done) => client.destroy(done))
    const { url, server } = await serveTorrent(torrent.torrentFile)
    servers.push(server)
    const magnet = `magnet:?xt=urn:btih:${torrent.infoHash}&xs=${encodeURIComponent(url)}`

    const probe = await plexo.api.probeUrl(magnet)
    expect(probe.kind).toBe('torrent')
    if (probe.kind !== 'torrent') throw new Error('Expected torrent metadata')
    expect(probe.suggestedFileName).toBe('notes.pdf')
  })

  test.describe('with nobody to ask', () => {
    test('a magnet link with no trackers and no DHT gives up at once', async ({ plexo }) => {
      const magnet = `magnet:?xt=urn:btih:${'ab'.repeat(20)}&dn=nothing`
      const started = Date.now()
      await expect(plexo.api.probeUrl(magnet)).rejects.toThrow(/Couldn’t find anyone sharing/)
      // Well inside the 3-minute wait for peers: there was nothing to wait for.
      expect(Date.now() - started).toBeLessThan(10_000)
    })
  })

  test.describe('with a DHT that reaches no one', () => {
    // A bootstrap node nobody listens on: the DHT's lookup ends with no nodes to ask, as it does
    // behind a VPN or firewall that drops BitTorrent's UDP.
    test.use({
      appEnv: {
        PLEXO_E2E_DHT: '1',
        PLEXO_E2E_DHT_BOOTSTRAP: '127.0.0.1:9',
        PLEXO_E2E_MAGNET_GRACE_MS: '3000'
      }
    })

    test('a magnet link says no peers are found yet, then gives up after a short wait', async ({
      plexo
    }) => {
      const link = await plexo.newDownload()
      await link.fill(`magnet:?xt=urn:btih:${'cd'.repeat(20)}&dn=nothing`)
      await expect(plexo.page.getByText('No peers found yet, still looking…')).toBeVisible()
      const noPeersYetAt = Date.now()
      await expect(plexo.page.getByText(/Couldn’t find anyone sharing/)).toBeVisible({
        timeout: 20_000
      })
      // It kept looking for the whole window, not one moment longer than it needed.
      expect(Date.now() - noPeersYetAt).toBeGreaterThan(2_000)
    })
  })

  test('a second search finds a peer the first one missed', async ({ plexo }) => {
    // The DHT's only node. It knows of no peer until the test announces the seeder to it, after
    // the first search came back empty.
    const { default: DHT } = (await import('bittorrent-dht' as string)) as {
      default: new (options: object) => {
        listen(port: number, address: string, cb: () => void): void
        address(): { port: number }
        announce(infoHash: string, port: number, cb: (error?: Error) => void): void
        destroy(cb?: () => void): void
      }
    }
    // `host`: what it announces is also kept in its own peer list, for a get_peers to find.
    const node = new DHT({ bootstrap: false, host: '127.0.0.1' })
    await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve))
    const bootstrap = `127.0.0.1:${node.address().port}`
    try {
      await plexo.relaunch({
        PLEXO_E2E_DHT: '1',
        PLEXO_E2E_DHT_BOOTSTRAP: bootstrap,
        PLEXO_E2E_MAGNET_GRACE_MS: '15000'
      })
      // Off the DHT, with no tracker: it never learns of Plexo, so it can't connect to it. Plexo
      // can only find it by asking the DHT node again.
      const { client: seeder, torrent } = await seed([named(seededBytes(300_000, 8), 'late.mkv')])
      clients.push(seeder)

      const link = await plexo.newDownload()
      await link.fill(`magnet:?xt=urn:btih:${torrent.infoHash}&dn=late`)
      await expect(plexo.page.getByText('No peers found yet, still looking…')).toBeVisible()

      await new Promise<void>((resolve, reject) =>
        node.announce(torrent.infoHash, seeder.address().port, (error) =>
          error ? reject(error) : resolve()
        )
      )

      // Its details arrived: the name, and the file list.
      await expect(plexo.page.getByText('late.mkv').first()).toBeVisible({ timeout: 20_000 })
      await expect(plexo.page.getByText('No peers found yet, still looking…')).toBeHidden()
    } finally {
      await new Promise<void>((resolve) => node.destroy(() => resolve()))
    }
  })

  test.describe('with a peer that never answers', () => {
    test.use({ appEnv: { PLEXO_E2E_MAGNET_MS: '1500' } })

    test('a magnet link still waits for its peers, then gives up', async ({ plexo }) => {
      // Accepts the connection and says nothing, so no metadata ever comes.
      const silent = createNetServer(() => {})
      await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
      try {
        const port = (silent.address() as AddressInfo).port
        const magnet = `magnet:?xt=urn:btih:${'ef'.repeat(20)}&dn=quiet&x.pe=127.0.0.1:${port}`
        await expect(plexo.api.probeUrl(magnet)).rejects.toThrow(
          /No peers responded to this magnet link/
        )
      } finally {
        silent.close()
      }
    })
  })
})
