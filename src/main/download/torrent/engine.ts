import { join } from 'node:path'
import type WebTorrent from 'webtorrent'
import type { ClientOptions, Store, StoreOptions } from 'webtorrent'
import { testKnobs } from '../../testKnobs'

// The only file that loads webtorrent. It's ESM-only and main is bundled as CommonJS, so it comes
// in through import(), once, and only when a torrent is first looked at.
let loaded: Promise<typeof WebTorrent> | null = null

function loadWebTorrent(): Promise<typeof WebTorrent> {
  loaded ??= import('webtorrent').then((module) => module.default)
  return loaded
}

let peerIdParser: Promise<(peerId: string) => string | null> | null = null

/** Names the client a peer runs from its peer id ("qBittorrent 4.6.2"), or null when unknown. */
export function loadClientNamer(): Promise<(peerId: string) => string | null> {
  peerIdParser ??= import('bittorrent-peerid').then(({ default: peerid }) => (peerId) => {
    try {
      const { client, version } = peerid(peerId)
      return client === 'unknown' ? null : [client, version].filter(Boolean).join(' ')
    } catch {
      return null
    }
  })
  return peerIdParser
}

/**
 * webtorrent's own file store, writing the torrent's top entry (its folder, or its one file) under
 * `name` rather than the torrent's: a download claims a free name, "Name (1)" when the torrent's
 * is taken. `onWritten` hears each file a piece landed in, once it's written.
 */
export async function storeNamed(name: string, onWritten: (path: string) => void): Promise<Store> {
  const { default: FsChunkStore } = await import('fs-chunk-store')
  return class extends FsChunkStore {
    constructor(chunkLength: number, options: StoreOptions) {
      super(chunkLength, {
        ...options,
        files: options.files.map((file) => ({
          path: join(name, ...file.path.split(/[\\/]/).slice(1)),
          length: file.length,
          offset: file.offset
        }))
      })
    }

    put(index: number, buf: Uint8Array, cb?: (error?: Error | null) => void): void {
      super.put(index, buf, (error) => {
        if (!error) for (const target of this.chunkMap[index] ?? []) onWritten(target.file.path)
        cb?.(error)
      })
    }
  }
}

/**
 * A webtorrent client set up for Plexo:
 * - uTP is off: its UDP sockets can't be pinned to a network the way `connect` pins TCP ones.
 * - Web seeds are off: webtorrent fetches them over HTTP itself, again past `connect`.
 * - No port mapping (UPnP, NAT-PMP) and no local peer discovery: nothing beyond the peers.
 */
export async function createClient(
  options: Pick<ClientOptions, 'connect' | 'maxConns'> = {}
): Promise<WebTorrent> {
  const Client = await loadWebTorrent()
  return new Client({
    utp: false,
    webSeeds: false,
    natUpnp: false,
    natPmp: false,
    lsd: false,
    dht: testKnobs.torrentDht,
    ...options
  })
}
