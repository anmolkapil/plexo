import type { Torrent, Wire } from 'webtorrent'
import { expect, LAN_ADDRESS, test, treeSha } from './fixtures'
import { seededBytes, sha256 } from './origin'
import { named, Swarm, torrentFileOnDisk } from './torrentSwarm'

// Downloading torrents: every byte right, every peer on a network, and the networks' controls,
// pause and relaunch working as they do for HTTP. The swarm is local (see torrentSwarm.ts); the
// checks fixture verifies each finished download's bytes and that nothing else was left behind.

const KB = 1024
const MB = 1024 * KB
const PIECE = 64 * KB

let swarm: Swarm
test.beforeEach(async () => {
  swarm = await new Swarm().start()
})
test.afterEach(async () => {
  await swarm.stop()
})

test.describe('torrent downloads', () => {
  test('a single-file torrent', async ({ plexo }) => {
    const data = seededBytes(2 * MB, 11)
    const torrent = await swarm.seed([named(data, 'movie.mkv')], { pieceLength: PIECE })

    await plexo.start(await torrentFileOnDisk(torrent), sha256(data))
    const done = await plexo.waitForTorrentStatus('completed', 30_000)
    expect(done.kind).toBe('torrent')
    expect(done.fileName).toBe('movie.mkv')
    expect(done.totalPieces).toBe((2 * MB) / PIECE)
  })

  test('a torrent of several files, published as its folder', async ({ plexo }) => {
    const files = [
      named(seededBytes(300 * KB, 21), 'a.bin'),
      named(seededBytes(700 * KB + 3, 22), 'b.bin'),
      named(seededBytes(5, 23), 'tiny.txt')
    ]
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    const expected = treeSha(
      files.map((data) => ({ path: (data as { name?: string }).name!, data }))
    )
    await plexo.start(await torrentFileOnDisk(torrent), expected)
    const done = await plexo.waitForTorrentStatus('completed', 30_000)
    expect(done.fileName).toBe('Album')
  })

  test('pause, quit, relaunch and resume: the pieces already done aren’t fetched again', async ({
    plexo
  }) => {
    const data = seededBytes(6 * MB, 31)
    const file = named(data, 'big.iso')
    // Slow enough to stop partway: three seeders at 300 KB/s each.
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit: 300 * KB })
    }

    const id = await plexo.start(await torrentFileOnDisk(torrent), sha256(data))
    await plexo.waitUntil((state) => state.bytesDownloaded >= 2 * MB, 30_000)
    await plexo.relaunch()
    const paused = await plexo.waitForTorrentStatus('paused')
    expect(paused.bytesDownloaded).toBeGreaterThanOrEqual(2 * MB)

    const sentBefore = swarm.uploaded()
    await plexo.api.resumeDownload(id)
    await plexo.waitForTorrentStatus('completed', 60_000)
    // What was missing, plus at most a few pieces each peer had half-sent when it stopped.
    expect(swarm.uploaded() - sentBefore).toBeLessThanOrEqual(
      data.length - paused.bytesDownloaded + 6 * PIECE
    )
  })
})

test.describe('choosing files', () => {
  /** Files of sizes that don't line up with pieces, so pieces straddle chosen and skipped ones. */
  function album(size: number, seed: number): Buffer[] {
    return ['a.bin', 'b.bin', 'c.bin', 'd.bin'].map((name, index) =>
      named(seededBytes(size + 7 * index + 5, seed + index), name)
    )
  }
  const shaOf = (files: Buffer[]): string =>
    treeSha(files.map((data) => ({ path: (data as { name?: string }).name!, data })))

  test('only the chosen files are downloaded and published', async ({ plexo }) => {
    const files = album(300 * KB, 61)
    const torrent = await swarm.seed(files, { folder: 'Album', pieceLength: PIECE })

    // a and c chosen: b and d never appear, though the pieces at their edges are fetched.
    await plexo.start(await torrentFileOnDisk(torrent), shaOf([files[0], files[2]]), {
      selectedFiles: [0, 2]
    })
    const done = await plexo.waitForTorrentStatus('completed', 30_000)
    expect(done.skippedBytes).toBeGreaterThan(0)
    expect(done.bytesDownloaded).toBe(done.totalBytes - done.skippedBytes!)
    expect(done.pieces.filter((piece) => piece.status === 'skipped').length).toBeGreaterThan(0)
  })

  test('the choice is kept through a quit, a relaunch and a resume', async ({ plexo }) => {
    const files = album(1500 * KB, 71)
    let torrent = await swarm.seed(files, {
      folder: 'Set',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Set',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    const id = await plexo.start(await torrentFileOnDisk(torrent), shaOf([files[1], files[3]]), {
      selectedFiles: [1, 3]
    })
    await plexo.waitUntil((state) => state.bytesDownloaded >= 1 * MB, 30_000)
    const before = await plexo.currentTorrent()
    await plexo.relaunch()
    const paused = await plexo.waitForTorrentStatus('paused')
    expect(paused.skippedBytes).toBe(before!.skippedBytes)
    await plexo.api.resumeDownload(id)
    await plexo.waitForTorrentStatus('completed', 60_000)
  })

  test('the choice changes as it runs: a file dropped never appears, one added comes in', async ({
    plexo
  }) => {
    const files = album(1500 * KB, 81)
    let torrent = await swarm.seed(files, {
      folder: 'Mix',
      pieceLength: PIECE,
      uploadLimit: 300 * KB
    })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed(files, {
        folder: 'Mix',
        pieceLength: PIECE,
        uploadLimit: 300 * KB
      })
    }

    // a and b chosen, then b swapped for c before either is near done.
    const id = await plexo.start(await torrentFileOnDisk(torrent), shaOf([files[0], files[2]]), {
      selectedFiles: [0, 1]
    })
    await plexo.waitUntil((state) => state.bytesDownloaded > 0, 30_000)
    await plexo.api.chooseTorrentFiles(id, [0, 2])
    const changed = await plexo.currentTorrent()
    expect(changed!.status).toBe('downloading')
    expect(changed!.files).toEqual({ chosen: 2, total: 4, selected: [0, 2] })
    await plexo.waitForTorrentStatus('completed', 60_000)
  })
})

test.describe('torrents over two networks', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for a second network')

  /** Three seeders of `data`, at `uploadLimit` each. */
  async function seedThree(data: Buffer, name: string, uploadLimit?: number): Promise<Torrent> {
    const file = named(data, name)
    let torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    for (let seeder = 1; seeder < 3; seeder++) {
      torrent = await swarm.seed([file], { pieceLength: PIECE, uploadLimit })
    }
    return torrent
  }

  test('both networks carry peers and deliver pieces', async ({ plexo }) => {
    const data = seededBytes(4 * MB, 41)
    const torrent = await seedThree(data, 'both.bin', 1 * MB)

    await plexo.start(await torrentFileOnDisk(torrent), sha256(data), { networks: ['a', 'b'] })
    const done = await plexo.waitForTorrentStatus('completed', 30_000)
    for (const id of ['a', 'b']) {
      const network = done.networks.find((entry) => entry.id === id)!
      expect(network.bytesDownloaded, `network ${id} delivered pieces`).toBeGreaterThan(0)
    }
    const seen = new Set(
      plexo.sessions.flat().flatMap((state) => (state.kind === 'torrent' ? state.peers : []))
    )
    expect(new Set([...seen].map((peer) => peer.interfaceId))).toEqual(new Set(['a', 'b']))
  })

  test('switching a network off moves its peers to the other', async ({ plexo }) => {
    const data = seededBytes(6 * MB, 42)
    const torrent = await seedThree(data, 'switch.bin', 300 * KB)

    const id = await plexo.start(await torrentFileOnDisk(torrent), sha256(data), {
      networks: ['a', 'b']
    })
    await plexo.waitUntil(
      (state) => state.networks.every((network) => network.bytesDownloaded > 0),
      30_000
    )
    await plexo.api.setDownloadNetwork(id, 'b', false)
    await plexo.waitUntil(
      (state) => state.kind === 'torrent' && !state.peers.some((peer) => peer.interfaceId === 'b')
    )
    const done = await plexo.waitForTorrentStatus('completed', 60_000)
    expect(done.networks.find((network) => network.id === 'b')?.enabled).toBe(false)
  })
})

test.describe('uploading', () => {
  test.skip(!LAN_ADDRESS, 'needs a second local address to stand in for the network')
  // A USB-tethered network, the one kind once left out: every network uploads, whatever its kind.
  test.use({ appEnv: { PLEXO_E2E_INTERFACES: `b=${LAN_ADDRESS}==usb` } })

  test('peers get pieces back over every network, USB-tethered ones too', async ({ plexo }) => {
    const data = seededBytes(4 * MB, 51)
    const torrent = await swarm.seed([named(data, 'shared.bin')], {
      pieceLength: PIECE,
      uploadLimit: 400 * KB
    })
    const other = await swarm.leech(torrent)
    let fromPlexo = 0
    let connected = false
    other.on('wire', (wire: Wire, address: string) => {
      // Plexo dials over network b, from the LAN address. A dual-stack listener reports it
      // IPv4-mapped: ::ffff:<address>:<port>.
      if (!address.replace(/^::ffff:/, '').startsWith(`${LAN_ADDRESS}:`)) return
      connected = true
      wire.on('download', (bytes: number) => (fromPlexo += bytes))
    })

    await plexo.start(await torrentFileOnDisk(torrent), sha256(data), { networks: ['b'] })
    const done = await plexo.waitForTorrentStatus('completed', 60_000)
    expect(connected, 'Plexo connected to the other client').toBe(true)
    expect(fromPlexo, 'what the other client received from Plexo').toBeGreaterThan(0)
    // What Plexo shows it sent: at least what arrived (a little may still be in flight at the end).
    const sentOverB = done.networks.find((network) => network.id === 'b')?.bytesUploaded ?? 0
    expect(sentOverB).toBeGreaterThanOrEqual(fromPlexo)
    expect(done.bytesUploaded).toBe(sentOverB)
    // Nothing is moving once it's done.
    expect(done.uploadSpeedBytesPerSec ?? 0).toBe(0)
  })
})
