import { test, expect, BLOCK } from './fixtures'

test.describe('probe file name from the link @smoke', () => {
  test('a bad escape in a folder still decodes the file name', async ({ plexo, serve }) => {
    const origin = await serve({ size: 3 * BLOCK })
    const result = await plexo.api.probeUrl(origin.url('/50%/My%20Report.pdf'))
    expect(result.suggestedFileName).toBe('My Report.pdf')
  })
})
