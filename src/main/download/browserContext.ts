import type { BrowserContext, BrowserCookie } from '../../shared/types'

const USER_AGENT = 'Plexo/1.0'

/** Called again for every redirect, so a site's session cookie never reaches the next host (its
 * CDN), while a cookie set for a whole domain still follows a hop within it. */
export function requestHeaders(url: URL, browser?: BrowserContext): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': browser?.userAgent ?? USER_AGENT }
  if (browser?.referer) headers['Referer'] = browser.referer
  const cookie = browser ? cookieHeader(url, browser.cookies) : ''
  if (cookie) headers['Cookie'] = cookie
  return headers
}

/** RFC 6265 §5.4. */
function cookieHeader(url: URL, cookies: readonly BrowserCookie[]): string {
  const host = url.hostname.toLowerCase()
  const path = url.pathname || '/'
  return cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase()
      const domainMatches = cookie.hostOnly
        ? host === domain
        : host === domain || host.endsWith(`.${domain}`)
      const pathMatches =
        path === cookie.path ||
        (path.startsWith(cookie.path) &&
          (cookie.path.endsWith('/') || path[cookie.path.length] === '/'))
      return domainMatches && pathMatches && (!cookie.secure || url.protocol === 'https:')
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => (cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value))
    .join('; ')
}

const MAX_COOKIES = 500
const MAX_TEXT = 8192
// A line break would start a header of its own, and `;` separates cookies.
// eslint-disable-next-line no-control-regex -- control characters are exactly what's refused
const UNSAFE = /[\x00-\x1f\x7f]/
// eslint-disable-next-line no-control-regex -- as above
const UNSAFE_IN_COOKIE = /[\x00-\x1f\x7f;]/

const isText = (value: unknown, unsafe = UNSAFE): value is string =>
  typeof value === 'string' && value.length <= MAX_TEXT && !unsafe.test(value)

/** It comes from outside Plexo (the extension, or a manifest read back from disk), so only known
 * fields are kept. */
export function browserContextFrom(value: unknown): BrowserContext | null {
  if (typeof value !== 'object' || value === null) return null
  const { cookies, referer, userAgent, name } = value as Record<string, unknown>
  if (!Array.isArray(cookies) || cookies.length > MAX_COOKIES) return null
  if (referer !== undefined && !(isText(referer) && /^https?:\/\//i.test(referer))) return null
  if (userAgent !== undefined && !isText(userAgent)) return null
  if (name !== undefined && !(isText(name) && name.length <= 40)) return null
  const checked: BrowserCookie[] = []
  for (const cookie of cookies) {
    if (typeof cookie !== 'object' || cookie === null) return null
    const { name, value, domain, hostOnly, path, secure } = cookie as Record<string, unknown>
    if (!isText(name, UNSAFE_IN_COOKIE) || !isText(value, UNSAFE_IN_COOKIE)) return null
    if (!isText(domain) || !isText(path) || !path.startsWith('/')) return null
    if (typeof hostOnly !== 'boolean' || typeof secure !== 'boolean') return null
    checked.push({ name, value, domain, hostOnly, path, secure })
  }
  return {
    cookies: checked,
    ...(referer !== undefined && { referer }),
    ...(userAgent !== undefined && { userAgent }),
    ...(name !== undefined && { name })
  }
}
