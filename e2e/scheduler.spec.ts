import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  pickWork,
  type AttemptView,
  type SchedulerPolicy,
  type SchedulerState
} from '../src/main/download/scheduler'
import type { BlockState, BlockStatus, ChunkStatus } from '../src/shared/types'

// J. Who fetches what. Pure, so the races that decide it (which stream asked first, how far
// along the holder is) are pinned down as inputs instead of left to timing.

const POLICY: SchedulerPolicy = { hedgeAfterMs: 5000, maxHedgesPerBlock: 2 }
const NOW = 100_000
const LENGTH = 1000

const block = (index: number, status: BlockStatus = 'pending', bytes = 0): BlockState => ({
  index,
  rangeStart: index * LENGTH,
  rangeEnd: index * LENGTH + LENGTH - 1,
  status,
  bytesDownloaded: bytes,
  bytesByInterface: {}
})

const stream = (
  id: number,
  interfaceId: string,
  status: ChunkStatus,
  speedBytesPerSec = 0
): SchedulerState['streams'][number] => ({ id, interfaceId, status, speedBytesPerSec })

const attempt = (
  streamId: number,
  networkId: string,
  kind: AttemptView['kind'] = 'primary',
  ageMs = 10_000
): AttemptView => ({ kind, streamId, networkId, startedAt: NOW - ageMs })

function state(parts: {
  blocks: BlockState[]
  streams?: SchedulerState['streams']
  attempts?: [number, AttemptView[]][]
  avoid?: [number, string][]
  hedgesUsed?: [number, number][]
}): SchedulerState {
  return {
    blocks: parts.blocks,
    streams: parts.streams ?? [],
    attempts: new Map(parts.attempts),
    avoid: new Map(parts.avoid),
    hedgesUsed: new Map(parts.hedgesUsed)
  }
}

const pick = (s: SchedulerState, id: number, networkId: string): string | undefined => {
  const work = pickWork(s, { id, networkId }, NOW, POLICY)
  return work && `${work.kind}:${work.block.index}`
}

test.describe('scheduler: taking the next block', () => {
  test('takes the first waiting block', () => {
    const blocks = [block(0, 'completed'), block(1, 'downloading'), block(2), block(3)]
    expect(pick(state({ blocks }), 9, 'a')).toBe('primary:2')
  })

  test('nothing waiting and nothing to race → nothing to do', () => {
    const blocks = [block(0, 'completed'), block(1, 'completed')]
    expect(pick(state({ blocks }), 9, 'a')).toBeUndefined()
  })

  test('a block a network got nothing from goes to another network that is free', () => {
    const s = state({
      blocks: [block(0), block(1)],
      streams: [stream(0, 'a', 'pending'), stream(1, 'b', 'pending')],
      avoid: [[0, 'b']]
    })
    // b skips the block it just failed on; a, free at the same moment, takes it.
    expect(pick(s, 1, 'b')).toBe('primary:1')
    expect(pick(s, 0, 'a')).toBe('primary:0')
  })

  test('…but takes it back when no other network is free, so it cannot be stranded', () => {
    const s = state({
      blocks: [block(0)],
      streams: [
        stream(0, 'a', 'downloading'),
        stream(1, 'a', 'retrying'),
        stream(2, 'b', 'pending')
      ],
      avoid: [[0, 'b']]
    })
    expect(pick(s, 2, 'b')).toBe('primary:0')
  })

  test('another network being free only matters for the network that failed', () => {
    const s = state({
      blocks: [block(0)],
      streams: [stream(0, 'a', 'pending'), stream(1, 'b', 'pending')],
      avoid: [[0, 'b']]
    })
    expect(pick(s, 0, 'a')).toBe('primary:0')
  })

  test('never a deadlock: with a block waiting and a stream idle, some idle stream takes it', () => {
    const networks = ['a', 'b', 'c']
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<BlockStatus>('pending', 'downloading', 'completed'), {
          minLength: 1,
          maxLength: 8
        }),
        fc.array(
          fc.record({
            interfaceId: fc.constantFrom(...networks),
            status: fc.constantFrom<ChunkStatus>('pending', 'downloading', 'retrying', 'error')
          }),
          { minLength: 1, maxLength: 8 }
        ),
        fc.array(fc.tuple(fc.nat(7), fc.constantFrom(...networks))),
        (blockStatuses, chunks, avoided) => {
          const s = state({
            blocks: blockStatuses.map((status, index) => block(index, status)),
            streams: chunks.map((c, id) => stream(id, c.interfaceId, c.status)),
            avoid: avoided
          })
          const idle = s.streams.filter((c) => c.status === 'pending')
          fc.pre(idle.length > 0 && s.blocks.some((b) => b.status === 'pending'))
          expect(idle.some((c) => pick(s, c.id, c.interfaceId)?.startsWith('primary'))).toBe(true)
        }
      )
    )
  })
})

test.describe('scheduler: racing a slow block', () => {
  // Block 0 is 1000 bytes with 200 done, held by stream 0 on network a at `speed`.
  const laggard = (
    speed: number,
    over: Partial<Parameters<typeof state>[0]> = {}
  ): SchedulerState =>
    state({
      blocks: [block(0, 'downloading', 200), block(1, 'completed')],
      streams: [stream(0, 'a', 'downloading', speed), stream(1, 'a', 'pending')],
      attempts: [[0, [attempt(0, 'a')]]],
      ...over
    })

  test('a free stream races the block whose holder needs longest', () => {
    // 800 bytes left at 10 B/s: 80 s to go, against a 5 s threshold.
    expect(pick(laggard(10), 1, 'a')).toBe('hedge:0')
  })

  test('a holder that has gone quiet has no finish time, so it is raced', () => {
    expect(pick(laggard(0), 1, 'a')).toBe('hedge:0')
  })

  test('a holder about to finish is left alone', () => {
    // 800 bytes left at 1000 B/s: 0.8 s.
    expect(pick(laggard(1000), 1, 'a')).toBeUndefined()
  })

  test('the threshold is the finish time, not the speed: a slow holder nearly done is left alone', () => {
    const s = state({
      blocks: [block(0, 'downloading', 990), block(1, 'completed')],
      streams: [stream(0, 'a', 'downloading', 10), stream(1, 'a', 'pending')],
      attempts: [[0, [attempt(0, 'a')]]]
    })
    expect(pick(s, 1, 'a')).toBeUndefined() // 10 bytes left at 10 B/s: 1 s
  })

  test('a holder that has only just started has no measured speed yet, so it is left alone', () => {
    const s = laggard(0, { attempts: [[0, [attempt(0, 'a', 'primary', 1000)]]] })
    expect(pick(s, 1, 'a')).toBeUndefined()
  })

  test('never while any block is still waiting: a hedge must not take work from the queue', () => {
    const s = laggard(0, { blocks: [block(0, 'downloading', 200), block(1)] })
    expect(pick(s, 1, 'a')).toBe('primary:1')
    // A stream that has to decline the waiting block does not race instead: b sits it out, and a
    // takes the block.
    const avoided = laggard(0, {
      blocks: [block(0, 'downloading', 200), block(1)],
      streams: [
        stream(0, 'a', 'downloading'),
        stream(1, 'b', 'pending'),
        stream(2, 'a', 'pending')
      ],
      avoid: [[1, 'b']]
    })
    expect(pick(avoided, 1, 'b')).toBeUndefined()
    expect(pick(avoided, 2, 'a')).toBe('primary:1')
  })

  test('one hedge at a time, and at most a few over a block’s life', () => {
    const hedged = laggard(0, { attempts: [[0, [attempt(0, 'a'), attempt(1, 'a', 'hedge')]]] })
    expect(pick(hedged, 2, 'a')).toBeUndefined()
    expect(pick(laggard(0, { hedgesUsed: [[0, 2]] }), 1, 'a')).toBeUndefined()
    expect(pick(laggard(0, { hedgesUsed: [[0, 1]] }), 1, 'a')).toBe('hedge:0')
  })

  test('a stream never races its own block', () => {
    expect(pick(laggard(0), 0, 'a')).toBeUndefined()
  })

  test('a block whose holder let go is not raced: it goes back to the queue', () => {
    const s = laggard(0, {
      blocks: [block(0, 'pending', 200), block(1, 'completed')],
      attempts: [[0, [attempt(1, 'b', 'hedge')]]]
    })
    expect(pick(s, 2, 'a')).toBe('primary:0')
  })

  test('the block with the longest way to go is raced first', () => {
    const s = state({
      blocks: [block(0, 'downloading', 200), block(1, 'downloading', 200)],
      streams: [
        stream(0, 'a', 'downloading', 100),
        stream(1, 'a', 'downloading', 20),
        stream(2, 'a', 'pending')
      ],
      attempts: [
        [0, [attempt(0, 'a')]],
        [1, [attempt(1, 'a')]]
      ]
    })
    expect(pick(s, 2, 'a')).toBe('hedge:1')
  })

  test('a network that got nothing from a block is not sent to race it', () => {
    expect(pick(laggard(0, { avoid: [[0, 'b']] }), 2, 'b')).toBeUndefined()
  })

  test('another network gets the first go, since the holder’s network may be what is slow', () => {
    const s = laggard(0, {
      streams: [
        stream(0, 'a', 'downloading', 0),
        stream(1, 'a', 'pending'),
        stream(2, 'b', 'pending')
      ]
    })
    expect(pick(s, 1, 'a')).toBeUndefined() // b is free, and would take it
    expect(pick(s, 2, 'b')).toBe('hedge:0')
  })

  test('…unless that other network would not take it, or none is free', () => {
    const streams = [
      stream(0, 'a', 'downloading', 0),
      stream(1, 'a', 'pending'),
      stream(2, 'b', 'pending')
    ]
    // b already got nothing from this block, so it will decline; a must not wait for it.
    expect(pick(laggard(0, { streams, avoid: [[0, 'b']] }), 1, 'a')).toBe('hedge:0')
    // b is busy.
    const busy = [streams[0], streams[1], stream(2, 'b', 'downloading')]
    expect(pick(laggard(0, { streams: busy }), 1, 'a')).toBe('hedge:0')
  })

  test('a block of unknown length is never raced', () => {
    const open = { ...block(0, 'downloading', 200), rangeEnd: null }
    const s = laggard(0, { blocks: [open] })
    expect(pick(s, 1, 'a')).toBeUndefined()
  })

  test('whatever is chosen is real work: a waiting block, or a lone primary’s block', () => {
    const networks = ['a', 'b']
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom<BlockStatus>('pending', 'downloading', 'completed'),
            bytes: fc.integer({ min: 0, max: LENGTH }),
            holderNetwork: fc.constantFrom(...networks),
            holderAge: fc.integer({ min: 0, max: 20_000 }),
            speed: fc.integer({ min: 0, max: 500 }),
            hedged: fc.boolean()
          }),
          { minLength: 1, maxLength: 6 }
        ),
        fc.constantFrom(...networks),
        (rows, myNetwork) => {
          const blocks = rows.map((r, i) => block(i, r.status, r.bytes))
          const streams = rows.map((r, i) => stream(i, r.holderNetwork, 'downloading', r.speed))
          const attempts: [number, AttemptView[]][] = []
          rows.forEach((r, i) => {
            if (r.status !== 'downloading') return
            const held = [attempt(i, r.holderNetwork, 'primary', r.holderAge)]
            if (r.hedged) held.push(attempt(i, 'b', 'hedge'))
            attempts.push([i, held])
          })
          const s = state({
            blocks,
            streams: [...streams, stream(99, myNetwork, 'pending')],
            attempts
          })
          const work = pickWork(s, { id: 99, networkId: myNetwork }, NOW, POLICY)
          if (!work) return
          if (work.kind === 'primary') {
            expect(work.block.status).toBe('pending')
          } else {
            expect(blocks.some((b) => b.status === 'pending')).toBe(false)
            expect(work.block.status).toBe('downloading')
            expect(s.attempts.get(work.block.index)).toHaveLength(1)
          }
        }
      )
    )
  })
})
