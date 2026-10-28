import { expect, test } from '@playwright/test'
import { acceptedLink } from '../src/renderer/src/utils/format'

test('a pasted torrent path may use forward slashes or a UNC share', () => {
  expect(acceptedLink('C:/Downloads/a.torrent')).toBe('C:/Downloads/a.torrent')
  expect(acceptedLink('c:/Downloads/a.torrent')).toBe('c:/Downloads/a.torrent')
  expect(acceptedLink('\\\\server\\share\\a.torrent')).toBe('\\\\server\\share\\a.torrent')
  expect(acceptedLink('//server/share/a.torrent')).toBe('//server/share/a.torrent')
  expect(acceptedLink('  /tmp/a.torrent  ')).toBe('/tmp/a.torrent')
  expect(acceptedLink('C:\\Downloads\\a.torrent')).toBe('C:\\Downloads\\a.torrent')
  expect(acceptedLink('https://example.com/a.torrent')).toBe('https://example.com/a.torrent')
  expect(acceptedLink('magnet:?xt=urn:btih:abc')).toBe('magnet:?xt=urn:btih:abc')
  expect(acceptedLink('notes.torrent')).toBeNull()
  expect(acceptedLink('C:a.torrent')).toBeNull()
  expect(acceptedLink('C:/Downloads/a.txt')).toBeNull()
})
