import { expect, test } from '@playwright/test'
import { mergeTrackers, normalizeTrackerUrl, parseTrackerList } from '../src/shared/torrentTrackers'

test.describe('torrent tracker helpers', () => {
  test('normalizeTrackerUrl accepts valid tracker URLs and cleans them', () => {
    expect(normalizeTrackerUrl('udp://tracker.opentrackr.org:1337/announce')).toBe(
      'udp://tracker.opentrackr.org:1337/announce'
    )
    expect(normalizeTrackerUrl('  http://tracker.example.com/announce/  ')).toBe(
      'http://tracker.example.com/announce'
    )
    expect(normalizeTrackerUrl('https://tracker.tamersunion.org:443/announce/')).toBe(
      'https://tracker.tamersunion.org/announce'
    )
    expect(normalizeTrackerUrl('http://tracker.example.com:8080/announce/')).toBe(
      'http://tracker.example.com:8080/announce'
    )
  })

  test('normalizeTrackerUrl rejects invalid schemes and malformed URLs', () => {
    expect(normalizeTrackerUrl('')).toBeNull()
    expect(normalizeTrackerUrl('   ')).toBeNull()
    expect(normalizeTrackerUrl('ftp://tracker.example.com/announce')).toBeNull()
    expect(normalizeTrackerUrl('file:///path/to/file')).toBeNull()
    expect(normalizeTrackerUrl('wss://tracker.btorrent.xyz')).toBeNull()
    expect(normalizeTrackerUrl('ws://tracker.openwebtorrent.com/')).toBeNull()
    expect(normalizeTrackerUrl('not-a-url')).toBeNull()
    expect(normalizeTrackerUrl('udp://')).toBeNull()
    expect(normalizeTrackerUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeTrackerUrl(null)).toBeNull()
    expect(normalizeTrackerUrl(42)).toBeNull()
    expect(normalizeTrackerUrl('http://tracker.example.com/' + 'a'.repeat(2050))).toBeNull()
  })

  test('parseTrackerList parses multi-line or comma-separated trackers, counts invalid lines, and deduplicates', () => {
    const input = `
      udp://tracker.opentrackr.org:1337/announce
      http://tracker.example.com/announce/

      invalid-url
      udp://tracker.opentrackr.org:1337/announce
      https://tracker.tamersunion.org/announce, ws://tracker.openwebtorrent.com/
    `
    const { valid, invalidCount } = parseTrackerList(input)
    expect(valid).toEqual([
      'udp://tracker.opentrackr.org:1337/announce',
      'http://tracker.example.com/announce',
      'https://tracker.tamersunion.org/announce'
    ])
    // invalid-url and ws://tracker.openwebtorrent.com/ are invalid
    expect(invalidCount).toBe(2)
  })

  test('parseTrackerList supports Windows (CRLF), Linux (LF), and macOS (CR) line breaks', () => {
    const windowsCrlf =
      'udp://tracker.opentrackr.org:1337/announce\r\n\r\nhttp://tracker.example.com/announce\r\n'
    const linuxLf =
      'udp://tracker.opentrackr.org:1337/announce\n\nhttp://tracker.example.com/announce\n'
    const macCr =
      'udp://tracker.opentrackr.org:1337/announce\r\rhttp://tracker.example.com/announce\r'

    const expected = [
      'udp://tracker.opentrackr.org:1337/announce',
      'http://tracker.example.com/announce'
    ]
    expect(parseTrackerList(windowsCrlf)).toEqual({ valid: expected, invalidCount: 0 })
    expect(parseTrackerList(linuxLf)).toEqual({ valid: expected, invalidCount: 0 })
    expect(parseTrackerList(macCr)).toEqual({ valid: expected, invalidCount: 0 })
  })

  test('mergeTrackers appends only unique new trackers', () => {
    const existing = [
      'udp://tracker.opentrackr.org:1337/announce',
      'http://tracker.example.com/announce'
    ]
    const additional = [
      'http://tracker.example.com/announce/',
      'https://tracker.tamersunion.org/announce',
      'udp://newtracker.org:6969/announce'
    ]
    const merged = mergeTrackers(existing, additional)
    expect(merged).toEqual([
      'udp://tracker.opentrackr.org:1337/announce',
      'http://tracker.example.com/announce',
      'https://tracker.tamersunion.org/announce',
      'udp://newtracker.org:6969/announce'
    ])
  })

  test('mergeTrackers handles case-insensitive duplicates and empty inputs', () => {
    expect(mergeTrackers([], [])).toEqual([])
    expect(mergeTrackers(['http://tracker.com/announce'], [])).toEqual([
      'http://tracker.com/announce'
    ])
    expect(
      mergeTrackers(
        ['udp://tracker.org:1337/announce'],
        ['UDP://TRACKER.ORG:1337/ANNOUNCE', 'udp://tracker2.org:1337/announce']
      )
    ).toEqual(['udp://tracker.org:1337/announce', 'udp://tracker2.org:1337/announce'])
  })
})
