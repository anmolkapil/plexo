import { once } from 'node:events'
import { expect, test } from '@playwright/test'
import { writeBuffers } from '../src/main/download/downloadFile'
import { WriteBudget, WriteQueue } from '../src/main/download/writeQueue'

test('adjacent ranges batch without crediting RAM admission as written progress', async () => {
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((resolve) => (started = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const calls: { position: number; data: Buffer }[] = []
  const budget = new WriteBudget(32, 16)
  const queue = new WriteQueue(async (buffers, position) => {
    calls.push({
      position,
      data: Buffer.concat(
        buffers.map((buffer) => Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      )
    })
    started()
    await gate
  }, budget)
  const first = queue.writer(0)
  const second = queue.writer(4)
  const written: number[] = []
  first.on('written', (bytes) => written.push(bytes))
  await Promise.all([
    new Promise<void>((resolve, reject) =>
      first.write(Buffer.from('abcd'), (error) => (error ? reject(error) : resolve()))
    ),
    new Promise<void>((resolve, reject) =>
      second.write(Buffer.from('efgh'), (error) => (error ? reject(error) : resolve()))
    )
  ])
  await began
  expect(written).toEqual([])
  expect(budget.used).toBe(8)
  expect(calls).toEqual([{ position: 0, data: Buffer.from('abcdefgh') }])
  const closed = Promise.all([once(first, 'close'), once(second, 'close')])
  first.end()
  second.end()
  release()
  await closed
  expect(written).toEqual([4])
  expect(budget.used).toBe(0)
})

test('two destinations share a hard admitted-byte budget and both make progress', async () => {
  const budget = new WriteBudget(128 * 1024, 64 * 1024)
  let bytes = 0
  const queues = [0, 1].map(
    () =>
      new WriteQueue(async (buffers) => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        bytes += buffers.reduce((sum, buffer) => sum + buffer.length, 0)
      }, budget)
  )
  const writers = queues.map((queue) => queue.writer(0))
  const closed = Promise.all(writers.map((writer) => once(writer, 'close')))
  for (const writer of writers) writer.end(Buffer.alloc(512 * 1024))
  await closed
  expect(bytes).toBe(1024 * 1024)
  expect(budget.peak).toBeLessThanOrEqual(budget.limit)
  expect(budget.used).toBe(0)
})

test('destroy waits for in-flight writes and removes queued data before a retry', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const began = new Promise<void>((resolve) => (started = resolve))
  const calls: string[] = []
  const queue = new WriteQueue(async (buffers) => {
    calls.push(
      Buffer.concat(
        buffers.map((buffer) => Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      ).toString()
    )
    started()
    await gate
  })
  const writer = queue.writer(0)
  await new Promise<void>((resolve) => writer.write(Buffer.from('first'), () => resolve()))
  await began
  await new Promise<void>((resolve) => writer.write(Buffer.from('later'), () => resolve()))
  let closed = false
  const stopped = once(writer, 'close').then(() => {
    closed = true
  })
  writer.destroy()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(closed).toBe(false)
  release()
  await stopped
  expect(calls).toEqual(['first'])
})

test('write errors settle every owner and release their budget', async () => {
  const budget = new WriteBudget(128, 128)
  const queue = new WriteQueue(async () => {
    throw new Error('disk full')
  }, budget)
  const writers = [queue.writer(0), queue.writer(4)]
  const errors: string[] = []
  for (const writer of writers) writer.on('error', (error) => errors.push(error.message))
  const closed = Promise.all(
    writers.map((writer) => new Promise<void>((resolve) => writer.once('close', resolve)))
  )
  writers[0].end(Buffer.from('abcd'))
  writers[1].end(Buffer.from('efgh'))
  await closed
  expect(errors).toEqual(['disk full', 'disk full'])
  expect(budget.used).toBe(0)
})

test('partial writev results advance both the buffers and positioned offset', async () => {
  const output = Buffer.alloc(8)
  await writeBuffers(
    {
      writev: async (buffers, position) => {
        const data = Buffer.concat(
          buffers.map((buffer) => Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength))
        )
        const count = Math.min(3, data.length)
        data.copy(output, position!, 0, count)
        return { bytesWritten: count, buffers }
      }
    },
    [Buffer.from('abcd'), Buffer.from('efgh')],
    0
  )
  expect(output.toString()).toBe('abcdefgh')
})
