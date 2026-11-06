import { expect, test } from '@playwright/test'
import {
  MAX_HLS_NESTING,
  parseHls,
  resolveHls,
  scopedHeaders,
  type FetchText
} from '../src/main/download/hls/playlist'

// HLS playlists: what is accepted, what is refused, and that credentials stay with their site.

const BASE = 'https://cdn.example.com/video/index.m3u8'

const media = (extra = '') =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:6\n${extra}#EXTINF:6.0,\nseg0.ts\n#EXTINF:4.5,\nseg1.ts\n#EXT-X-ENDLIST\n`

test.describe('parseHls', () => {
  test('a media playlist lists its segments in order, resolved against the playlist URL', () => {
    const parsed = parseHls(media(), BASE)
    expect(parsed).toEqual({
      kind: 'media',
      urls: ['https://cdn.example.com/video/seg0.ts', 'https://cdn.example.com/video/seg1.ts'],
      durationSeconds: 10.5,
      extension: '.ts'
    })
  })

  test('an init map comes first and makes the output mp4', () => {
    const parsed = parseHls(media('#EXT-X-MAP:URI="init.mp4"\n'), BASE)
    expect(parsed.kind === 'media' && parsed.urls[0]).toBe('https://cdn.example.com/video/init.mp4')
    expect(parsed.kind === 'media' && parsed.extension).toBe('.mp4')
  })

  test('a master playlist orders variants best first and pairs each with its audio', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8",DEFAULT=YES',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="aud"',
      'high.m3u8'
    ].join('\n')
    const parsed = parseHls(text, BASE)
    if (parsed.kind !== 'master') throw new Error('expected a master playlist')
    expect(parsed.variants.map((v) => v.bandwidth)).toEqual([4_000_000, 800_000])
    expect(parsed.variants[0].resolution).toBe('1920x1080')
    expect(parsed.variants[0].audioUrl).toBe('https://cdn.example.com/video/audio.m3u8')
  })

  test('things that would give a broken file are refused', () => {
    expect(() => parseHls('<html></html>', BASE)).toThrow(/not return an HLS playlist/)
    expect(() => parseHls(media('#EXT-X-KEY:METHOD=AES-128,URI="k"\n'), BASE)).toThrow(/Encrypted/)
    expect(() => parseHls(media('#EXT-X-BYTERANGE:100@0\n'), BASE)).toThrow(/byte-range/)
    expect(() => parseHls('#EXTM3U\n#EXTINF:6,\nseg0.ts\n', BASE)).toThrow(/Live HLS/)
  })

  test('a segment that is not http(s) is refused', () => {
    expect(() => parseHls(media().replace('seg0.ts', 'file:///etc/passwd'), BASE)).toThrow(
      /Only HTTP and HTTPS/
    )
  })

  test('METHOD=NONE is not encryption', () => {
    expect(() => parseHls(media('#EXT-X-KEY:METHOD=NONE\n'), BASE)).not.toThrow()
  })
})

test.describe('scopedHeaders', () => {
  const headers = { cookie: 'a=b', authorization: 'Bearer x', origin: 'https://a.com', accept: '*/*' }

  test('credentials stay on their own site', () => {
    expect(scopedHeaders(headers, 'https://a.com/x', 'https://b.com/y')).toEqual({ accept: '*/*' })
  })

  test('and travel within it', () => {
    expect(scopedHeaders(headers, 'https://a.com/x', 'https://a.com/y')).toEqual(headers)
  })
})

test.describe('resolveHls', () => {
  const pages: Record<string, string> = {
    'https://cdn.example.com/m.m3u8': [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="aud.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"',
      'v.m3u8'
    ].join('\n'),
    'https://cdn.example.com/v.m3u8': media(),
    'https://cdn.example.com/aud.m3u8': media()
  }
  const fetchText: FetchText = async (url) => ({ text: pages[url], url })

  test('follows a master playlist to video and audio', async () => {
    const out = await resolveHls('https://cdn.example.com/m.m3u8', {}, fetchText)
    expect(out.urls).toHaveLength(2)
    expect(out.audio?.urls).toHaveLength(2)
    expect(out.identity).toMatch(/^[0-9a-f]{64}$/)
  })

  test('stops following playlists that nest too deeply', async () => {
    const loop: FetchText = async (url) => ({
      text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nnext.m3u8\n',
      url
    })
    await expect(resolveHls('https://x.com/a.m3u8', {}, loop)).rejects.toThrow(/nested/)
    expect(MAX_HLS_NESTING).toBe(3)
  })

  test('does not send one site\'s cookies to another', async () => {
    const seen: Array<Record<string, string>> = []
    const spy: FetchText = async (url, h) => {
      seen.push(h)
      return url.includes('other')
        ? { text: media(), url }
        : {
            text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://other.example.net/v.m3u8\n',
            url
          }
    }
    await resolveHls('https://cdn.example.com/m.m3u8', { cookie: 'secret' }, spy)
    expect(seen[0].cookie).toBe('secret')
    expect(seen[1].cookie).toBeUndefined()
  })
})
