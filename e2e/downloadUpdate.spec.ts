import { expect, test } from '@playwright/test'
import { applyDownloadUpdate } from '../src/shared/downloadUpdate'
import type {
  HttpBlockState,
  HttpDownloadUpdate,
  TorrentDownloadUpdate,
  TorrentPieceState
} from '../src/shared/types'

// O. How the window puts a download back together from the updates the main process sends: a
// snapshot, then only the blocks that changed.

const block = (index: number, bytesDownloaded = 0): HttpBlockState => ({
  kind: 'http',
  index,
  rangeStart: index * 100,
  rangeEnd: index * 100 + 99,
  status: bytesDownloaded === 100 ? 'completed' : bytesDownloaded ? 'downloading' : 'pending',
  bytesDownloaded,
  bytesByInterface: bytesDownloaded ? { a: bytesDownloaded } : {}
})

const update = (seq: number, blocks: HttpBlockState[], id = 'd1'): HttpDownloadUpdate => ({
  seq,
  state: {
    kind: 'http',
    id,
    url: 'http://example.test/file',
    fileName: 'file',
    destinationPath: '/tmp/file',
    totalBytes: 400,
    bytesDownloaded: blocks.reduce((sum, entry) => sum + entry.bytesDownloaded, 0),
    speedBytesPerSec: 0,
    status: 'downloading',
    networks: [],
    streams: [],
    peakStreams: 0,
    totalBlocks: 4,
    blockSizeBytes: 100,
    startedAt: 0
  },
  blocks
})

const full = (seq: number, id = 'd1'): HttpDownloadUpdate =>
  update(seq, [block(0), block(1), block(2), block(3)], id)

test.describe('download updates', () => {
  test('changed blocks land on the ones already there', () => {
    const start = applyDownloadUpdate(null, full(1))
    const next = applyDownloadUpdate(start, update(2, [block(1, 50)]))!
    expect(next.kind).toBe('http')
    if (next.kind !== 'http' || start?.kind !== 'http') throw new Error('Expected HTTP state')
    expect(next.blocks.map((entry) => entry.bytesDownloaded)).toEqual([0, 50, 0, 0])
    expect(next.seq).toBe(2)
    // What was there is left untouched.
    expect(start.blocks[1].bytesDownloaded).toBe(0)
  })

  test('an update sent before a snapshot was taken, arriving after it, is ignored', () => {
    const snapshot = applyDownloadUpdate(
      null,
      update(5, [block(0, 100), block(1, 80), block(2), block(3)])
    )
    expect(applyDownloadUpdate(snapshot, update(4, [block(1, 40)]))).toBe(snapshot)
    // And a snapshot older than what is already there changes nothing.
    const newer = applyDownloadUpdate(snapshot, update(6, [block(1, 100)]))
    expect(applyDownloadUpdate(newer, full(5))).toBe(newer)
  })

  test('a download with no whole picture yet waits for one', () => {
    // A window that has just loaded can be sent a partial update before its snapshot comes back.
    expect(applyDownloadUpdate(null, update(3, [block(2, 10)]))).toBeNull()
    const previous = applyDownloadUpdate(null, full(1, 'old'))
    expect(applyDownloadUpdate(previous, update(3, [block(2, 10)], 'new'))).toBe(previous)
    // A new download's first update has every block, and stands on its own.
    expect(applyDownloadUpdate(previous, full(1, 'new'))?.id).toBe('new')
  })

  test('torrent piece updates merge independently from live peer state', () => {
    const piece = (index: number, provisionalBytes = 0): TorrentPieceState => ({
      kind: 'torrent',
      index,
      rangeStart: index * 100,
      rangeEnd: index * 100 + 99,
      status: provisionalBytes > 0 ? 'downloading' : 'pending',
      bytesDownloaded: 0,
      provisionalBytes,
      bytesByInterface: {}
    })
    const torrentUpdate = (seq: number, pieces: TorrentPieceState[]): TorrentDownloadUpdate => ({
      seq,
      state: {
        kind: 'torrent',
        id: 'torrent',
        url: 'magnet:?xt=urn:btih:test',
        fileName: 'files',
        destinationPath: '/tmp/files',
        totalBytes: 200,
        bytesDownloaded: 0,
        speedBytesPerSec: 0,
        status: 'downloading',
        networks: [],
        peers: [],
        peakPeers: 0,
        totalPieces: 2,
        pieceLength: 100,
        files: { chosen: 1, total: 1 },
        folder: false,
        skippedBytes: 0,
        bytesUploaded: 0,
        uploadSpeedBytesPerSec: 0,
        startedAt: 0
      },
      pieces
    })
    const start = applyDownloadUpdate(null, torrentUpdate(1, [piece(0), piece(1)]))
    const next = applyDownloadUpdate(start, torrentUpdate(2, [piece(1, 40)]))
    expect(next?.kind).toBe('torrent')
    if (next?.kind !== 'torrent') throw new Error('Expected torrent state')
    expect(next.pieces.map((entry) => entry.provisionalBytes)).toEqual([0, 40])
    expect(next.peers).toEqual([])
  })
})
