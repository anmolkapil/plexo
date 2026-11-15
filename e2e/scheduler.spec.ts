import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import {
  partEnd,
  pickWork,
  type AttemptView,
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
}): SchedulerState {
  return {
    blocks: parts.blocks,
    streams: parts.streams ?? [],
    attempts: new Map(parts.attempts),
    avoid: new Map(parts.avoid),
    hedgesUsed: new Map(parts.hedgesUsed)
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

test.describe('scheduler: splitting what is left', () => {
  // Parts of 1000-byte blocks, halved down to 100 bytes a side.
  const SPLIT: SchedulerPolicy = { ...POLICY, minSplitBytes: 100 }
  const part = (
    streamId: number,
    networkId: string,
    startOffset: number,
    end: number,
    received: number,
    kind: AttemptView['kind'] = 'primary'
  ): AttemptView => ({
    ...attempt(streamId, networkId, kind),
    startOffset,
    end,
    networkReceived: received
  })
  const split = (s: SchedulerState, id = 9, networkId = 'a'): string | undefined => {
    const work = pickWork(s, { id, networkId, speedBytesPerSec: 100 }, NOW, SPLIT)
    return work && `${work.kind}:${work.block.index}@${work.start ?? ''}-${work.end ?? ''}`
  }
  // Holders as fast as anyone free, as from a server that caps each connection: racing them
  // wouldn't pay.
  const capped = (
    attempts: [number, AttemptView[]][],
    blocks = [block(0, 'downloading'), block(1, 'downloading')],
    over: Partial<SchedulerState> = {}
  ): SchedulerState => ({
    ...state({
      blocks,
      streams: [
        stream(0, 'a', 'downloading', 100),
        stream(1, 'a', 'downloading', 100),
        stream(2, 'a', 'downloading', 100),
        stream(9, 'a', 'pending', 100)
      ],
      attempts
    }),
    ...over
  })

  test('a free stream takes the back half of the part with the most bytes left', () => {
    const s = capped([
      [0, [part(0, 'a', 0, 1000, 600)]],
      [1, [part(1, 'a', 0, 1000, 200)]]
    ])
    // Block 1 has 800 left, from byte 200: the free stream takes 600–1000.
    expect(split(s)).toBe('split:1@600-1000')
  })

  test('a part split off before can be split again', () => {
    const s = capped([[0, [part(0, 'a', 0, 500, 400), part(1, 'a', 500, 1000, 50, 'split')]]])
    expect(split(s)).toBe('split:0@775-1000')
  })

  test('no speeds come into it: a holder far faster than the free stream is still split', () => {
    const s = capped([[0, [part(0, 'a', 0, 1000, 0)]]])
    const fast = { ...s, streams: [stream(0, 'a', 'downloading', 1e9), stream(9, 'a', 'pending')] }
    expect(split(fast)).toBe('split:0@500-1000')
  })

  test('nothing is split smaller than the minimum on either side', () => {
    expect(split(capped([[0, [part(0, 'a', 0, 1000, 800)]]]))).toBe('split:0@900-1000')
    expect(split(capped([[0, [part(0, 'a', 0, 1000, 801)]]]))).toBeUndefined()
  })

  test('never while a block is still waiting: that comes first', () => {
    const s = capped([[0, [part(0, 'a', 0, 1000, 0)]]], [block(0, 'downloading'), block(1)])
    expect(split(s)).toBe('primary:1@-')
  })

  test('not while the disk is behind', () => {
    const s = capped([[0, [part(0, 'a', 0, 1000, 0)]]], undefined, { diskBehind: true })
    expect(split(s)).toBeUndefined()
  })

  test('not a block of unknown length', () => {
    const open = { ...block(0, 'downloading'), rangeEnd: null }
    expect(split(capped([[0, [part(0, 'a', 0, 1000, 0)]]], [open]))).toBeUndefined()
  })

  test('not a part being raced, nor one on its way out', () => {
    const raced = capped([
      [0, [part(0, 'a', 0, 1000, 0), part(1, 'a', 0, 1000, 0, 'hedge')]],
      [1, [{ ...part(2, 'a', 0, 1000, 0), abortReason: 'refresh' }]]
    ])
    expect(split(raced)).toBeUndefined()
  })

  test('not by a network that got nothing from the block', () => {
    const s = capped([[0, [part(0, 'a', 0, 1000, 0)]]], undefined, {
      avoid: new Map([[0, 'a']])
    })
    expect(split(s)).toBeUndefined()
  })

  test('racing still comes first when it would clearly pay', () => {
    const s = capped([[0, [part(0, 'a', 0, 1000, 0)]]])
    const crawling = {
      ...s,
      streams: [stream(0, 'a', 'downloading', 1), stream(9, 'a', 'pending')]
    }
    expect(
      pickWork(crawling, { id: 9, networkId: 'a', speedBytesPerSec: 100 }, NOW, SPLIT)?.kind
    ).toBe('hedge')
  })

  test('a race is over what is left of the part from the frontier, not the whole block', () => {
    // 100 bytes left before the split at 500: not worth racing at 10 B/s against a 5 s bar.
    const s = capped(
      [[0, [part(0, 'a', 0, 500, 400), part(1, 'a', 500, 1000, 0, 'split')]]],
      [block(0, 'downloading', 400)]
    )
    const slow = { ...s, streams: [stream(0, 'a', 'downloading', 30), stream(9, 'a', 'pending')] }
    expect(pickWork(slow, { id: 9, networkId: 'a' }, NOW, POLICY)).toBeUndefined()
  })

  test('what a split left unfetched when it stopped is taken whole, before anything else', () => {
    // A split of 500–1000 stopped at 700: 700–1000 is nobody's.
    const s = capped([[0, [part(0, 'a', 0, 500, 100)]]], [block(0, 'downloading', 100)], {
      segments: new Map([[0, [{ start: 500, end: 700 }]]]),
      diskBehind: true
    })
    expect(split(s)).toBe('split:0@700-1000')
  })

  test('a gap is only looked for behind someone fetching from the frontier', () => {
    const s = capped([[0, [part(1, 'a', 500, 1000, 0, 'split')]]], [block(0, 'downloading', 100)])
    expect(split(s)).not.toMatch(/@100-/)
  })

  test('partEnd stops a part where the next one begins', () => {
    const b = block(0, 'downloading', 100)
    const attempts = [part(1, 'a', 600, 1000, 0, 'split')]
    expect(partEnd(b, attempts, [{ start: 300, end: 400 }], 100)).toBe(300)
    expect(partEnd(b, attempts, [], 100)).toBe(600)
    expect(partEnd(b, [], [], 100)).toBe(1000)
    expect(partEnd({ ...b, rangeEnd: null }, [], [], 0)).toBeNull()
  })

  test('whatever is handed out is a stretch nobody else is fetching or has', () => {
    // Blocks cut into parts at random: each part is held, raced, or already in as a segment.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            frontier: fc.integer({ min: 0, max: 400 }),
            cuts: fc.uniqueArray(fc.integer({ min: 401, max: 999 }), { maxLength: 4 }),
            fates: fc.array(fc.constantFrom('held', 'segment', 'gap'), {
              minLength: 5,
              maxLength: 5
            }),
            received: fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 5, maxLength: 5 }),
            raced: fc.boolean()
          }),
          { minLength: 1, maxLength: 3 }
        ),
        (rows) => {
          const blocks = rows.map((r, i) => block(i, 'downloading', r.frontier))
          const attempts: [number, AttemptView[]][] = []
          const segments = new Map<number, { start: number; end: number }[]>()
          let id = 0
          rows.forEach((r, i) => {
            const bounds = [r.frontier, ...[...r.cuts].sort((a, b) => a - b), LENGTH]
            const held: AttemptView[] = []
            const done: { start: number; end: number }[] = []
            for (let k = 0; k + 1 < bounds.length; k++) {
              const [start, end] = [bounds[k], bounds[k + 1]]
              const fate = k === 0 ? 'held' : r.fates[k]
              const got = Math.min(r.received[k], end - start)
              if (fate === 'held') {
                held.push(part(id++, 'a', start, end, got, k === 0 ? 'primary' : 'split'))
                if (k === 0 && r.raced) held.push(part(id++, 'a', start, end, got, 'hedge'))
              } else if (fate === 'segment' && got > 0) {
                done.push({ start, end: start + got })
              }
            }
            attempts.push([i, held])
            segments.set(i, done)
          })
          const s: SchedulerState = {
            ...state({ blocks, streams: [stream(99, 'a', 'pending')], attempts }),
            segments
          }
          const work = pickWork(s, { id: 99, networkId: 'a' }, NOW, SPLIT)
          if (!work || work.kind !== 'split') return
          const start = work.start!
          const end = work.end!
          expect(start).toBeGreaterThan(work.block.bytesDownloaded)
          expect(end).toBeGreaterThan(start)
          expect(end).toBeLessThanOrEqual(LENGTH)
          // Nothing already in overlaps it.
          for (const segment of segments.get(work.block.index) ?? []) {
            expect(segment.end <= start || segment.start >= end).toBe(true)
          }
          // Whoever is fetching across its start has yet to reach it, by at least the minimum,
          // and isn't being raced; nobody else is fetching any of it.
          for (const other of s.attempts.get(work.block.index) ?? []) {
            const from = other.startOffset!
            const to = other.end!
            if (from < start && to > start) {
              expect(from + other.networkReceived! + 100).toBeLessThanOrEqual(start)
              expect(end - start).toBeGreaterThanOrEqual(100)
              expect(to).toBe(end)
              expect(other.kind === 'split' || !rows[work.block.index].raced).toBe(true)
            } else {
              expect(to <= start || from >= end).toBe(true)
            }
          }
        }
      )
    )
  })
})
