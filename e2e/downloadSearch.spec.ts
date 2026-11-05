import { expect, test } from '@playwright/test'
import {
  filterDownloadsByQuery,
  matchesSearch,
  normalizeSearchQuery,
  searchTokens
} from '../src/shared/downloadSearch'

test.describe('download search @smoke', () => {
  const sampleDownloads = [
    {
      fileName: 'Ubuntu-24.04-desktop-amd64.iso',
      url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso'
    },
    {
      fileName: 'Node-v22.1.0-linux-x64.tar.gz',
      url: 'https://nodejs.org/dist/v22.1.0/node-v22.1.0-linux-x64.tar.gz'
    },
    {
      fileName: 'Debian-12.5.0-netinst.iso',
      url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.5.0-amd64-netinst.iso'
    },
    {
      fileName: 'Big_Buck_Bunny_1080p.mp4',
      url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4'
    },
    {
      fileName: 'café_recording.mp3',
      url: 'https://example.com/audio/caf%C3%A9.mp3'
    }
  ]

  test('empty or whitespace query matches everything', () => {
    expect(matchesSearch(sampleDownloads[0], '')).toBe(true)
    expect(matchesSearch(sampleDownloads[0], '   ')).toBe(true)
    expect(filterDownloadsByQuery(sampleDownloads, '')).toEqual(sampleDownloads)
    expect(filterDownloadsByQuery(sampleDownloads, '   \t  ')).toEqual(sampleDownloads)
  })

  test('case-insensitive substring match on fileName', () => {
    expect(matchesSearch(sampleDownloads[0], 'ubuntu')).toBe(true)
    expect(matchesSearch(sampleDownloads[0], 'UBUNTU')).toBe(true)
    expect(matchesSearch(sampleDownloads[0], 'amd64')).toBe(true)
    expect(matchesSearch(sampleDownloads[1], 'node')).toBe(true)
    expect(matchesSearch(sampleDownloads[1], 'TAR.GZ')).toBe(true)
    expect(matchesSearch(sampleDownloads[2], 'debian')).toBe(true)
  })

  test('matches against url if fileName does not match', () => {
    // URL contains "releases.ubuntu.com", fileName does not
    expect(matchesSearch(sampleDownloads[0], 'releases')).toBe(true)
    // URL contains "cdimage", fileName does not
    expect(matchesSearch(sampleDownloads[2], 'cdimage')).toBe(true)
    // URL contains "commondatastorage", fileName does not
    expect(matchesSearch(sampleDownloads[3], 'commondatastorage')).toBe(true)
  })

  test('multi-token AND search matches across name and url', () => {
    expect(matchesSearch(sampleDownloads[0], 'ubuntu iso')).toBe(true)
    expect(matchesSearch(sampleDownloads[0], 'ubuntu 24.04 desktop')).toBe(true)
    expect(matchesSearch(sampleDownloads[0], 'ubuntu 24.04 windows')).toBe(false)
    expect(matchesSearch(sampleDownloads[3], 'bunny 1080p')).toBe(true)
  })

  test('unicode normalization matches composed and decomposed characters', () => {
    const composed = 'café'
    const decomposed = 'cafe\u0301'

    expect(matchesSearch(sampleDownloads[4], composed)).toBe(true)
    expect(matchesSearch(sampleDownloads[4], decomposed)).toBe(true)
    expect(normalizeSearchQuery(decomposed)).toBe(normalizeSearchQuery(composed))
  })

  test('filters array preserving original order', () => {
    const isoDownloads = filterDownloadsByQuery(sampleDownloads, 'iso')
    expect(isoDownloads).toHaveLength(2)
    expect(isoDownloads[0].fileName).toBe('Ubuntu-24.04-desktop-amd64.iso')
    expect(isoDownloads[1].fileName).toBe('Debian-12.5.0-netinst.iso')

    const noMatches = filterDownloadsByQuery(sampleDownloads, 'nonexistent_file')
    expect(noMatches).toHaveLength(0)
  })

  test('searchTokens and token array matching avoid redundant string splitting', () => {
    const tokens = searchTokens('  UBUNTU   Desktop  ')
    expect(tokens).toEqual(['ubuntu', 'desktop'])
    expect(searchTokens('   ')).toEqual([])
    expect(matchesSearch(sampleDownloads[0], tokens)).toBe(true)
    expect(matchesSearch(sampleDownloads[1], tokens)).toBe(false)
  })
})
