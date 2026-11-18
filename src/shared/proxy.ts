import type { ProxyConfig } from './types'

type Endpoint = Pick<ProxyConfig, 'type' | 'host' | 'port' | 'username'>

/** A host as typed, compared: an IPv6 address with or without its brackets, any case. */
function comparableHost(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
}

/** Whether a saved proxy password may go to `next`: only to the proxy and account it was saved
 * for, as with the news server's (see UsenetServerDialog's keepsPassword). A changed type, host,
 * port or username has to have it typed again. */
export function sameProxyEndpoint(saved: Endpoint, next: Endpoint): boolean {
  return (
    saved.type === next.type &&
    comparableHost(saved.host) === comparableHost(next.host) &&
    saved.port === next.port &&
    (saved.username?.trim() || undefined) === (next.username?.trim() || undefined)
  )
}
