import { expect, test } from '@playwright/test'
import type { BrowserWindow } from 'electron'
import { CompanionServer, isAllowedOrigin } from '../src/main/companion/server'
import type { CompanionDownloadPayload } from '../src/shared/types'

test.describe('Companion Server POST /download', () => {
  let server: CompanionServer
  let port: number
  let deliveredPayloads: CompanionDownloadPayload[] = []
  let activeDownload = false
  const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

  const mockWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: () => {},
    show: () => {},
    focus: () => {},
    webContents: {
      send: (_channel: string, payload: CompanionDownloadPayload) => {
        deliveredPayloads.push(payload)
      }
    }
  } as unknown as BrowserWindow

  test.beforeEach(async () => {
    deliveredPayloads = []
    activeDownload = false
    server = new CompanionServer(
      () => mockWindow,
      () => activeDownload,
      0, // Bind to an ephemeral port
      [extensionOrigin]
    )
    port = await server.start()
  })

  test.afterEach(async () => {
    await server.stop()
  })

  test('accepts valid download request from extension origin and delivers normalized payload', async () => {
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: extensionOrigin,
        'X-Plexo-Companion': '1'
      },
      body: JSON.stringify({
        url: 'https://example.com/files/archive.zip',
        suggestedFileName: 'archive.zip',
        cookies: 'session_id=secret123; user=test',
        referer: 'https://example.com/downloads'
      })
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(extensionOrigin)

    const data = await res.json()
    expect(data).toMatchObject({
      success: true,
      message: 'Download received by Plexo',
      hasActiveDownload: false
    })

    expect(deliveredPayloads).toHaveLength(1)
    expect(deliveredPayloads[0]).toEqual({
      url: 'https://example.com/files/archive.zip',
      suggestedFileName: 'archive.zip',
      cookies: 'session_id=secret123; user=test',
      referer: 'https://example.com/downloads',
      userAgent: undefined,
      headers: {
        Cookie: 'session_id=secret123; user=test',
        Referer: 'https://example.com/downloads'
      }
    })
  })

  test('reports active download state when Plexo is busy', async () => {
    activeDownload = true
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
      },
      body: JSON.stringify({
        url: 'https://example.com/video.mp4'
      })
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.hasActiveDownload).toBe(true)
  })

  test('rejects requests from unauthorized web origins with 403 Forbidden', async () => {
    const maliciousOrigin = 'https://malicious-website.com'
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: maliciousOrigin
      },
      body: JSON.stringify({
        url: 'https://example.com/malware.exe'
      })
    })

    expect(res.status).toBe(403)
    const data = await res.json()
    expect(data.error).toContain('Untrusted origin')
    expect(deliveredPayloads).toHaveLength(0)
  })

  test('rejects CORS preflight OPTIONS from unauthorized web origins', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST'
      }
    })

    expect(res.status).toBe(403)
  })

  test('accepts CORS preflight OPTIONS from extension origin', async () => {
    const extensionOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'OPTIONS',
      headers: {
        Origin: extensionOrigin,
        'Access-Control-Request-Method': 'POST'
      }
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(extensionOrigin)
  })

  test('rejects invalid or non-HTTP URLs with 400 Bad Request', async () => {
    const testCases = ['', 'ftp://files.example.com/data.tar', 'javascript:alert(1)']

    for (const url of testCases) {
      const res = await fetch(`http://127.0.0.1:${port}/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
        },
        body: JSON.stringify({ url })
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toContain('Invalid URL')
    }

    expect(deliveredPayloads).toHaveLength(0)
  })

  test('rejects malformed JSON body with 400 Bad Request', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
      },
      body: 'not a valid json string'
    })

    expect(res.status).toBe(400)
    expect(deliveredPayloads).toHaveLength(0)
  })

  test('accepts POST /focus to bring window to front', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/focus`, {
      method: 'POST',
      headers: {
        Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        'X-Plexo-Companion': '1'
      }
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toEqual({ success: true })
  })

  test('validates extension origin pattern', () => {
    expect(isAllowedOrigin(extensionOrigin, [extensionOrigin])).toBe(true)
    expect(
      isAllowedOrigin('moz-extension://12345678-1234-1234-1234-123456789abc', [extensionOrigin])
    ).toBe(false)
    expect(isAllowedOrigin('https://google.com', [extensionOrigin])).toBe(false)
    expect(isAllowedOrigin('http://localhost:3000', [extensionOrigin])).toBe(false)
    expect(isAllowedOrigin('null', [extensionOrigin])).toBe(false)
    expect(isAllowedOrigin('', [extensionOrigin])).toBe(false)
    expect(isAllowedOrigin(undefined, [extensionOrigin])).toBe(false)
  })
})
