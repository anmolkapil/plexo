import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { ClientOptions, Torrent } from 'webtorrent'

// A small BitTorrent swarm in the test process: a tracker on 127.0.0.1, and webtorrent clients
// seeding (or fetching) through it. The app finds the peers by announcing to the tracker, as it
// would on the internet; no DHT is involved anywhere.

// ESM-only: specs are compiled to CommonJS, so these come in through import().
export const loadWebTorrent = (): Promise<typeof WebTorrent> =>
  import('webtorrent').then((module) => module.default)

interface TrackerServer {
  listen(port: number, hostname: string, onListening: () => void): void
  close(onClose?: () => void): void
  http: { address(): { port: number } }
}
const loadTracker = (): Promise<new (options: object) => TrackerServer> =>
  import('bittorrent-tracker/server' as string).then((module) => module.default)

/** Nothing beyond the swarm: no DHT, local discovery, port mapping or uTP. */
export const QUIET: ClientOptions = {
  dht: false,
  lsd: false,
  natUpnp: false,
  natPmp: false,
  utp: false
}

/** A file to seed: its bytes, named as it appears in the torrent. */
export function named(data: Buffer, name: string): Buffer {
  return Object.assign(data, { name })
}

export class Swarm {
  private clients: WebTorrent[] = []
  private tracker: TrackerServer | null = null
  private announce: string[] = []

  async start(): Promise<this> {
    const Server = await loadTracker()
    const tracker = new Server({ udp: false, ws: false, stats: false })
    await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve))
    this.tracker = tracker
    this.announce = [`http://127.0.0.1:${tracker.http.address().port}/announce`]
    return this
  }

  /** A client of the swarm, gone at stop(). */
  async client(options: ClientOptions = {}): Promise<WebTorrent> {
    const client = new (await loadWebTorrent())({ ...QUIET, ...options })
    this.clients.push(client)
    return client
  }

  /** A client seeding `files`: one file, or a folder of them named `folder`. The same files,
   * name and piece length make the same torrent, so seed() again for another seeder of it. */
  async seed(
    files: Buffer[],
    options: { folder?: string; pieceLength?: number; uploadLimit?: number } = {}
  ): Promise<Torrent> {
    const client = await this.client({ uploadLimit: options.uploadLimit })
    // A folder of its own, as leech() has: left to webtorrent, every seeder shares /tmp/webtorrent,
    // and two tests seeding different files under one name in parallel overwrite each other's —
    // the seeder then serves pieces that fail verification, forever.
    const path = await mkdtemp(join(tmpdir(), 'plexo-seed-'))
    return new Promise((resolve) =>
      client.seed(
        files.length === 1 ? files[0] : files,
        { name: options.folder, pieceLength: options.pieceLength, announce: this.announce, path },
        resolve
      )
    )
  }

  /** A client fetching `torrent` from the swarm, into a folder of its own. */
  async leech(torrent: Torrent): Promise<Torrent> {
    const client = await this.client()
    const path = await mkdtemp(join(tmpdir(), 'plexo-leech-'))
    return client.add(torrent.torrentFile, { path })
  }

  /** What every client has uploaded, all together. */
  uploaded(): number {
    return this.clients
      .flatMap((client) => client.torrents)
      .reduce((sum, torrent) => sum + torrent.uploaded, 0)
  }

  async stop(): Promise<void> {
    await Promise.all(
      this.clients.splice(0).map((client) => new Promise((done) => client.destroy(done)))
    )
    await new Promise<void>((resolve) => (this.tracker ? this.tracker.close(resolve) : resolve()))
  }
}

/** `torrent`'s .torrent, written to a file for the app to open. */
export async function torrentFileOnDisk(torrent: Torrent): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'plexo-torrent-')), `${torrent.name}.torrent`)
  await writeFile(path, torrent.torrentFile)
  return path
}
