import { execFileSync } from 'node:child_process'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { markSparse } from '../src/main/download/sparseFile'

test('a staging file on NTFS is sparse, so a write far into it zeroes nothing first', async () => {
  test.skip(process.platform !== 'win32', 'NTFS only')
  const dir = await mkdtemp(join(tmpdir(), 'plexo-sparse-'))
  try {
    const sparse = join(dir, 'sparse.plexo')
    await (await open(sparse, 'wx+')).close()

    expect(await markSparse(sparse)).toBe(true)
    expect(execFileSync('fsutil', ['sparse', 'queryflag', sparse], { encoding: 'utf8' })).toMatch(
      /is set as sparse/i
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
