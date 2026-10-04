// webtorrent and parse-torrent ship no types. These cover only what Plexo (and its e2e tests) use.

declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events'
  import type { Socket } from 'node:net'

  export interface ClientOptions {
    dht?: boolean
    lsd?: boolean
    utp?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    webSeeds?: boolean
    tracker?: boolean | object
    maxConns?: number
    /** Bytes per second this client uploads at most. */
    uploadLimit?: number
    /** Added by Plexo's patch (patches/webtorrent+3.0.21.patch): opens every outgoing TCP peer
     * connection. */
    connect?: (options: { host: string; port: number }) => Socket
  }

  /** What webtorrent hands a store: the torrent's files, paths relative to `path`. */
  export interface StoreOptions {
    path: string
    files: { path: string; length: number; offset: number }[]
    [option: string]: unknown
  }

  export type Store = new (chunkLength: number, options: StoreOptions) => object

  export interface AddOptions {
    path?: string
    /** Builds the torrent's storage; webtorrent's own is fs-chunk-store. */
    store?: Store
    deselect?: boolean
    announce?: string[]
    skipVerify?: boolean
    bitfield?: Uint8Array
  }

  export interface SeedOptions {
    name?: string
    pieceLength?: number
    announce?: string[]
    /** Where it keeps the seeded files; webtorrent's default is a shared /tmp/webtorrent. */
    path?: string
  }

  /** One peer connection (bittorrent-protocol). Emits 'piece' (index, offset, buffer) for each
   * block it receives, and 'close'. */
  export interface Wire extends EventEmitter {
    destroy(): void
    unchoke(): void
    /** The remote peer's id, hex: set once it has shaken hands. */
    peerId: string | null
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    magnetURI: string
    torrentFile: Uint8Array
    name: string
    length: number
    /** Bytes sent to peers. */
    uploaded: number
    /** In the torrent's order; a deselected file's pieces aren't fetched for it. */
    files: { select(): void; deselect(): void }[]
    pieces: unknown[]
    /** Takes pieces `start` to `end` out of every selection, trimming or splitting those that
     * reach further. */
    deselect(start: number, end: number): void
    /** Which pieces are verified and on disk. */
    bitfield: { get(index: number): boolean }
    destroy(options?: { destroyStore?: boolean }, callback?: (error?: Error) => void): void
    addPeer(address: string): boolean
  }

  export default class WebTorrent extends EventEmitter {
    constructor(options?: ClientOptions)
    maxConns: number
    destroyed: boolean
    torrents: Torrent[]
    add(torrentId: string | Uint8Array, options?: AddOptions): Torrent
    seed(
      input: Buffer | string | (Buffer | string)[],
      options: SeedOptions,
      onSeed: (torrent: Torrent) => void
    ): Torrent
    address(): { address: string; family: string; port: number }
    destroy(callback?: (error?: Error) => void): void
    /** Private: its listening server, where peers dial in. */
    _connPool: { tcpServer: import('node:net').Server } | null
  }
}

declare module 'fs-chunk-store' {
  import type { StoreOptions } from 'webtorrent'
  /** webtorrent's default store: a torrent's files on disk, at `path` + each file's path. */
  export default class FsChunkStore {
    constructor(chunkLength: number, options: StoreOptions)
    /** By piece: the stretches of the torrent's files it covers. */
    chunkMap: { file: { path: string } }[][]
    put(index: number, buf: Uint8Array, cb?: (error?: Error | null) => void): void
  }
}

declare module 'bittorrent-peerid' {
  /** The client a peer id names, e.g. { client: 'qBittorrent', version: '4.6.2' }. */
  export default function peerid(peerId: string | Buffer): { client: string; version?: string }
}

declare module 'parse-torrent' {
  export interface ParsedTorrent {
    infoHash: string
    name?: string
    length?: number
    pieceLength?: number
    files?: { path: string; name: string; length: number; offset: number }[]
  }
  export default function parseTorrent(torrentId: string | Uint8Array): Promise<ParsedTorrent>
}
