import { execFileSync } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { markSparse } from '../src/main/download/sparseFile'

/** How long one 64 KiB write 1 GiB into the empty file at `path` takes. */
async function farWriteMs(path: string): Promise<number> {
  const handle = await open(path, 'r+')
  const started = performance.now()
  await handle.write(Buffer.alloc(64 * 1024, 1), 0, 64 * 1024, 1024 ** 3)
  const ms = performance.now() - started
  await handle.close()
  return ms
}

test('a staging file on NTFS is sparse, so a write far into it zeroes nothing first', async () => {
  test.skip(process.platform !== 'win32', 'NTFS only')
  const dir = await mkdtemp(join(tmpdir(), 'plexo-sparse-'))
  try {
    const plain = join(dir, 'plain.plexo')
    const sparse = join(dir, 'sparse.plexo')
    for (const path of [plain, sparse]) await (await open(path, 'wx+')).close()

    expect(await markSparse(sparse)).toBe(true)
    expect(execFileSync('fsutil', ['sparse', 'queryflag', sparse], { encoding: 'utf8' })).toMatch(
      /is set as sparse/i
    )
    // Not asserted, as timings vary by runner; printed for the record.
    console.log(
      `far write: plain ${await farWriteMs(plain)} ms, sparse ${await farWriteMs(sparse)} ms`
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
