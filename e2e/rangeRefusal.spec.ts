import { expect, test } from '@playwright/test'
import { describeError } from '../src/shared/errors'

const LINK_GONE = 'This link no longer works. Paste a new link to continue.'

test('a 416 reads as a link that no longer works', () => {
  expect(describeError('Unexpected status 416 for range request')).toBe(LINK_GONE)
  expect(describeError('Unexpected status 404 for range request')).toBe(LINK_GONE)
  expect(describeError('Unexpected status 500 for range request')).toBe(
    'Unexpected status 500 for range request'
  )
})
