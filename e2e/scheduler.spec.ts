import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  pickWork,
  type AttemptView,
  type NetworkLoad,
  type SchedulerPolicy,
  type SchedulerState
} from '../src/main/download/scheduler'
import type { HttpBlockState, HttpBlockStatus, HttpStreamStatus } from '../src/shared/types'

// J. Who fetches what. Pure, so the races that decide it (which stream asked first, how far
// along the holder is) are pinned down as inputs instead of left to timing.

const POLICY: SchedulerPolicy = { hedgeAfterMs: 5000, maxHedgesPerBlock: 2, startupMs: 1000 }
const NOW = 100_000
const LENGTH = 1000

const block = (index: number, status: HttpBlockStatus = 'pending', bytes = 0): HttpBlockState => ({
  kind: 'http',
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
  status: HttpStreamStatus,
  speedBytesPerSec = 0
): SchedulerState['streams'][number] => ({ id, interfaceId, status, speedBytesPerSec })

const attempt = (
  streamId: number,
  networkId: string,
  kind: AttemptView['kind'] = 'primary',
  ageMs = 10_000
): AttemptView => ({ kind, streamId, networkId, startedAt: NOW - ageMs })

function state(parts: {
  blocks: HttpBlockState[]
  streams?: SchedulerState['streams']
  attempts?: [number, AttemptView[]][]
  avoid?: [number, string][]
  hedgesUsed?: [number, number][]
  networks?: [string, NetworkLoad][]
}): SchedulerState {
  return {
    blocks: parts.blocks,
    streams: parts.streams ?? [],
    attempts: new Map(parts.attempts),
    avoid: new Map(parts.avoid),
    hedgesUsed: new Map(parts.hedgesUsed),
    networks: parts.networks && new Map(parts.networks)
  }
}

const pick = (
  s: SchedulerState,
  id: number,
  networkId: string,
  speedBytesPerSec?: number
): string | undefined => {
  const work = pickWork(s, { id, networkId, speedBytesPerSec }, NOW, POLICY)
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
        fc.array(fc.constantFrom<HttpBlockStatus>('pending', 'downloading', 'completed'), {
          minLength: 1,
          maxLength: 8
        }),
        fc.array(
          fc.record({
            interfaceId: fc.constantFrom(...networks),
            status: fc.constantFrom<HttpStreamStatus>(
              'pending',
              'downloading',
              'retrying',
              'paused'
            )
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

  test('…but one quiet because its writer is full is as slow as the disk, so it is left alone', () => {
    const held = { ...attempt(0, 'a'), writeWaiting: true }
    expect(pick(laggard(0, { attempts: [[0, [held]]] }), 1, 'a')).toBeUndefined()
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

  test('a block whose hedge is stuck too is raced again, up to a few over its life', () => {
    const streams = [
      stream(0, 'a', 'downloading', 0),
      stream(1, 'a', 'downloading', 0),
      stream(2, 'a', 'pending')
    ]
    const hedged = laggard(0, {
      streams,
      attempts: [[0, [attempt(0, 'a'), attempt(1, 'a', 'hedge')]]],
      hedgesUsed: [[0, 1]]
    })
    expect(pick(hedged, 2, 'a')).toBe('hedge:0')
    expect(pick(laggard(0, { hedgesUsed: [[0, 2]] }), 1, 'a')).toBeUndefined()
  })

  test('…but not while its hedge is doing fine', () => {
    // The hedge will be done in 0.8 s: nobody could beat that.
    const hedged = laggard(0, {
      streams: [
        stream(0, 'a', 'downloading', 0),
        stream(1, 'a', 'downloading', 1000),
        stream(2, 'a', 'pending')
      ],
      attempts: [[0, [attempt(0, 'a'), attempt(1, 'a', 'hedge')]]],
      hedgesUsed: [[0, 1]]
    })
    expect(pick(hedged, 2, 'a')).toBeUndefined()
  })

  test('a free stream that has shown its speed races as soon as it would clearly finish first', () => {
    // 800 bytes left at 200 B/s: 4 s. Under the 5 s a stream of unknown speed waits for, but a
    // stream that fetched its last block at 800 B/s would be done in 1 s + 1 s startup.
    expect(pick(laggard(200), 1, 'a')).toBeUndefined()
    expect(pick(laggard(200), 1, 'a', 800)).toBe('hedge:0')
    // Not when it would only finish a little sooner: at 400 B/s it needs 3 s, over half of 4 s.
    expect(pick(laggard(200), 1, 'a', 400)).toBeUndefined()
  })

  test('a free stream of unknown speed races a block that needs at least hedgeAfterMs more', () => {
    // 800 bytes left at 160 B/s: exactly 5 s. At 200 B/s, 4 s: left alone.
    expect(pick(laggard(160), 1, 'a')).toBe('hedge:0')
    expect(pick(laggard(200), 1, 'a')).toBeUndefined()
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

  test('whatever is chosen is real work: a waiting block, or a block still being fetched', () => {
    const networks = ['a', 'b']
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status: fc.constantFrom<HttpBlockStatus>('pending', 'downloading', 'completed'),
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
            const attempts = s.attempts.get(work.block.index) ?? []
            expect(attempts.some((a) => a.kind === 'primary')).toBe(true)
            expect(attempts.some((a) => a.streamId === 99)).toBe(false)
          }
        }
      )
    )
  })
})

test('no racing while the disk is behind, and racing resumes once it keeps up', () => {
  const s = state({
    blocks: [block(0, 'downloading')],
    streams: [stream(0, 'a', 'downloading'), stream(1, 'b', 'pending')],
    attempts: [[0, [attempt(0, 'a')]]]
  })
  expect(pick({ ...s, diskBehind: true }, 1, 'b')).toBeUndefined()
  expect(pick(s, 1, 'b')).toBe('hedge:0')
})

test.describe('scheduler: splitting a block at the end', () => {
  // Block 0 is 4 MiB, 1 MiB of it done, held by stream 0 on network a at `speed`: as when a
  // server caps each connection, a free stream is no faster than the holder, and the network
  // runs at a quarter of its peak now that most of its streams are done.
  const MIB = 1024 * 1024
  const SPLIT_POLICY: SchedulerPolicy = { ...POLICY, minSplitBytes: 256 * 1024 }
  const big = (status: HttpBlockStatus, bytes: number): HttpBlockState => ({
    ...block(0, status, bytes),
    rangeEnd: 4 * MIB - 1
  })
  const held = (startOffset: number, received: number, streamId = 0): AttemptView => ({
    ...attempt(streamId, 'a'),
    startOffset,
    received
  })
  const load = (speedBytesPerSec: number, peakBytesPerSec: number): NetworkLoad => ({
    speedBytesPerSec,
    peakBytesPerSec
  })
  const SPARE = load(1_000_000, 4_000_000)
  const FULL = load(3_900_000, 4_000_000)
  const capped = (speed: number, over: Partial<Parameters<typeof state>[0]> = {}): SchedulerState =>
    state({
      blocks: [big('downloading', MIB)],
      streams: [stream(0, 'a', 'downloading', speed), stream(1, 'a', 'pending')],
      attempts: [[0, [held(0, MIB)]]],
      networks: [['a', SPARE]],
      ...over
    })
  const split = (
    s: SchedulerState,
    speed?: number,
    policy = SPLIT_POLICY
  ): ReturnType<typeof pickWork> =>
    pickWork(s, { id: 1, networkId: 'a', speedBytesPerSec: speed }, NOW, policy)

  test('a free stream no faster than the holder takes the second half of what it has left', () => {
    // 3 MiB left at 100 KB/s: about 31 s. Racing it at the same speed would gain nothing.
    const work = split(capped(100_000), 100_000)
    expect(work?.kind).toBe('hedge')
    expect(work?.startOffset).toBe(MIB + 1.5 * MIB)
  })

  test('the split is in proportion to speed, so both finish together', () => {
    const work = split(capped(100_000), 50_000)
    // A third of the 3 MiB left, from the end.
    expect(work?.startOffset).toBe(4 * MIB - Math.floor((3 * MIB) / 3))
  })

  test('a free stream twice as fast still races as before, from where the holder has got to', () => {
    const work = split(capped(100_000), 400_000)
    expect(work?.kind).toBe('hedge')
    expect(work?.startOffset).toBeUndefined()
  })

  test('never without a policy for it, nor for a stream whose speed is not known', () => {
    // Either races as before, the whole of what is left: 31 s is over hedgeAfterMs.
    expect(split(capped(100_000), 100_000, POLICY)?.startOffset).toBeUndefined()
    expect(split(capped(100_000), undefined)?.startOffset).toBeUndefined()
  })

  test('not when either part would be under the least worth a request, or the block is nearly done', () => {
    const nearlyDone = capped(100_000, {
      blocks: [big('downloading', 4 * MIB - 300 * 1024)],
      attempts: [[0, [held(0, 4 * MIB - 300 * 1024)]]]
    })
    expect(split(nearlyDone, 100_000)).toBeUndefined()
    // 3 MiB at 2 MB/s is 1.5 s: under hedgeAfterMs.
    expect(split(capped(2_000_000), 2_000_000)).toBeUndefined()
  })

  test('a block already split is split again where it has longest to go', () => {
    // The holder has 1 MiB to go up to where stream 2 started (at 2 MiB); stream 2 has 2 MiB.
    const s = capped(100_000, {
      streams: [
        stream(0, 'a', 'downloading', 100_000),
        stream(1, 'a', 'pending'),
        stream(2, 'a', 'downloading', 100_000)
      ],
      attempts: [[0, [held(0, MIB), { ...held(2 * MIB, 0, 2), kind: 'hedge' }]]]
    })
    expect(split(s, 100_000)?.startOffset).toBe(3 * MIB)
  })

  test('what a split already fetched bounds the part ahead of it', () => {
    const s = { ...capped(100_000), segments: new Map([[0, [{ start: 2 * MIB, end: 4 * MIB }]]]) }
    // Only the 1 MiB up to the segment is left to share.
    expect(split(s, 100_000)?.startOffset).toBe(1.5 * MIB)
  })

  test('no more than two hedges at a time, splits included', () => {
    const s = capped(100_000, {
      streams: [
        stream(0, 'a', 'downloading', 100_000),
        stream(1, 'a', 'pending'),
        stream(2, 'a', 'downloading', 100_000),
        stream(3, 'a', 'downloading', 100_000)
      ],
      attempts: [
        [
          0,
          [
            held(0, MIB),
            { ...held(3 * MIB, 0, 2), kind: 'hedge' },
            { ...held(3.5 * MIB, 0, 3), kind: 'hedge' }
          ]
        ]
      ]
    })
    expect(split(s, 100_000)).toBeUndefined()
  })

  test('only while the networks have room to spare: on a full one the holder speeds up by itself', () => {
    expect(
      split(capped(100_000, { networks: [['a', FULL]] }), 100_000)?.startOffset
    ).toBeUndefined()
    // Not known, or no peak measured yet: as if full.
    expect(split(capped(100_000, { networks: [] }), 100_000)?.startOffset).toBeUndefined()
    expect(
      split(capped(100_000, { networks: [['a', load(0, 0)]] }), 100_000)?.startOffset
    ).toBeUndefined()
  })

  test("both networks need room: the requester's, and the holder's", () => {
    // The holder is on network b, the requester on a.
    const across = (a: NetworkLoad, b: NetworkLoad): SchedulerState =>
      capped(100_000, {
        streams: [stream(0, 'b', 'downloading', 100_000), stream(1, 'a', 'pending')],
        attempts: [[0, [{ ...held(0, MIB), networkId: 'b' }]]],
        networks: [
          ['a', a],
          ['b', b]
        ]
      })
    expect(split(across(SPARE, SPARE), 100_000)?.startOffset).toBe(MIB + 1.5 * MIB)
    // A full holder network: the holder would run on past the split point.
    expect(split(across(SPARE, FULL), 100_000)?.startOffset).toBeUndefined()
    // A full requester network: the split would only take from its other streams.
    expect(split(across(FULL, SPARE), 100_000)?.startOffset).toBeUndefined()
  })

  test('a holder that went quiet is still raced on a full network, as before', () => {
    const s = capped(0, { networks: [['a', FULL]] })
    const work = split(s, 100_000)
    expect(work?.kind).toBe('hedge')
    expect(work?.startOffset).toBeUndefined()
  })
})
