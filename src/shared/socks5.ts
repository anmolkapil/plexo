import type { Socks5Host } from './types'

/** One line of a pasted proxy list, as a host. Understands `host:port`, `host:port:user:pass`,
 * `user:pass@host:port` and any of them behind `socks5://` (or `socks5h://`); no port means 1080.
 * Null for a line that is none of those. */
export function parseSocks5Line(line: string): Omit<Socks5Host, 'id' | 'enabled'> | null {
  let text = line.trim().replace(/^socks5h?:\/\//i, '')
  if (!text || text.startsWith('#')) return null
  text = text.replace(/\/+$/, '')

  let username: string | undefined
  let password: string | undefined
  let address = text
  const at = text.lastIndexOf('@')
  if (at >= 0) {
    const credentials = text.slice(0, at)
    address = text.slice(at + 1)
    const colon = credentials.indexOf(':')
    username = colon >= 0 ? credentials.slice(0, colon) : credentials
    password = colon >= 0 ? credentials.slice(colon + 1) : undefined
  }

  let host: string
  let portText: string | undefined
  if (address.startsWith('[')) {
    // An IPv6 address in brackets, then optionally :port.
    const end = address.indexOf(']')
    if (end < 0) return null
    host = address.slice(1, end)
    portText = address.slice(end + 1).replace(/^:/, '') || undefined
  } else {
    const parts = address.split(':')
    const withCredentials = at < 0 && parts.length === 4 // host:port:user:pass
    if (parts.length > 2 && !withCredentials) return null
    host = parts[0]
    portText = parts[1]
    if (withCredentials) {
      username = parts[2]
      password = parts[3]
    }
  }

  const port = portText === undefined || portText === '' ? 1080 : Number(portText)
  if (!host || !/^[^\s/]+$/.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  }
}
