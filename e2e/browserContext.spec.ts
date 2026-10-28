import { expect, test } from '@playwright/test'
import { browserContextFrom, requestHeaders } from '../src/main/download/browserContext'
import type { BrowserCookie } from '../src/shared/types'

// Pure, so checked without the app.

const cookie = (fields: Partial<BrowserCookie>): BrowserCookie => ({
  name: 'session',
  value: 'secret',
  domain: 'example.com',
  hostOnly: false,
  path: '/',
  secure: true,
  ...fields
})

const sentTo = (url: string, cookies: BrowserCookie[]): string | undefined =>
  requestHeaders(new URL(url), { cookies })['Cookie']

test('a domain cookie follows a hop within its domain', () => {
  // drive.google.com redirects to drive.usercontent.google.com, which needs the .google.com sign-in.
  const google = cookie({ name: 'SID', domain: '.google.com' })
  expect(sentTo('https://drive.usercontent.google.com/download?id=1', [google])).toBe('SID=secret')
})

test("a site's cookies never reach another site", () => {
  const github = cookie({ name: 'user_session', domain: 'github.com', hostOnly: true })
  const githubDomain = cookie({ name: 'logged_in', domain: '.github.com' })
  expect(sentTo('https://objects.githubusercontent.com/x', [github, githubDomain])).toBeUndefined()
  expect(sentTo('https://notgithub.com/x', [github, githubDomain])).toBeUndefined()
  // A host-only cookie stays off subdomains too.
  expect(sentTo('https://api.github.com/x', [github])).toBeUndefined()
})

test('a link with a username and password sends basic authorization @smoke', () => {
  const headers = requestHeaders(new URL('https://user:p%40ss@files.example.com/dl/a.zip'))
  expect(headers.Authorization).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`)
  // A token with no password is still basic auth, with an empty password.
  expect(requestHeaders(new URL('https://token@files.example.com/a.zip')).Authorization).toBe(
    `Basic ${Buffer.from('token:').toString('base64')}`
  )
  expect(requestHeaders(new URL('https://files.example.com/a.zip')).Authorization).toBeUndefined()
})

test('authorization stays on the host named in the link @smoke', () => {
  const start = new URL('https://user:secret@files.example/a')
  const token = `Basic ${Buffer.from('user:secret').toString('base64')}`
  // A relative redirect keeps the userinfo, so the same host still receives it.
  expect(requestHeaders(new URL('/b', start)).Authorization).toBe(token)
  // An absolute redirect does not inherit it, so another host is not sent the password.
  expect(requestHeaders(new URL('https://cdn.example/b', start)).Authorization).toBeUndefined()
  expect(requestHeaders(new URL('//cdn.example/b', start)).Authorization).toBeUndefined()
})

test('path and secure decide as a browser does, longest path first', () => {
  const root = cookie({ name: 'a', path: '/' })
  const docs = cookie({ name: 'b', path: '/docs' })
  expect(sentTo('https://example.com/docs/file.zip', [root, docs])).toBe('b=secret; a=secret')
  expect(sentTo('https://example.com/docsx/file.zip', [root, docs])).toBe('a=secret')
  expect(sentTo('http://example.com/docs/file.zip', [root, docs])).toBeUndefined()
})

test('browser context from outside is checked, and a header break is refused', () => {
  const valid = { cookies: [cookie({})], referer: 'https://example.com/page', extra: 'dropped' }
  expect(browserContextFrom(valid)).toEqual({
    cookies: [cookie({})],
    referer: 'https://example.com/page'
  })
  expect(browserContextFrom({ cookies: [cookie({ value: 'a\r\nX-Evil: 1' })] })).toBeNull()
  expect(browserContextFrom({ cookies: [], userAgent: 'UA\nHost: evil' })).toBeNull()
  expect(browserContextFrom({ cookies: [], referer: 'javascript:alert(1)' })).toBeNull()
  expect(browserContextFrom('cookies')).toBeNull()
})
