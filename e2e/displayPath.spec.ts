import { expect, test } from '@playwright/test'
import { toDisplayPath } from '../src/renderer/src/utils/format'

test("a download under home still shortens when the folder's accents differ", () => {
  const home = '/Users/caf\u00e9'
  const path = '/Users/cafe\u0301/Downloads'
  expect(toDisplayPath(path, home)).toBe('~/Downloads')
  expect(toDisplayPath('C:\\Users\\Me\\Downloads', 'C:\\Users\\Me')).toBe('~\\Downloads')
  expect(toDisplayPath('/Users/Me/Downloads', '/Users/Me')).toBe('~/Downloads')
  expect(toDisplayPath('/Users/me', '/Users/me')).toBe('~')
  expect(toDisplayPath('/Users/me2/Downloads', '/Users/me')).toBe('/Users/me2/Downloads')
  const other = '/tmp/cafe\u0301/file'
  expect(toDisplayPath(other, home)).toBe(other)
})
