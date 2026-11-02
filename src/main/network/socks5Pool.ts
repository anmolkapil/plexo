import type { ProxyConfig, Socks5Host, Socks5Settings } from '../../shared/types'

// A host that fails this many connection attempts in a row is left alone for a while, and for
// twice as long each time it goes down again without having worked in between.
const FAILURES_BEFORE_COOLDOWN = 3
const COOLDOWN_MS = 20_000
const MAX_COOLDOWN_MS = 5 * 60_000

/** What a connection gets while SOCKS5 is on but no host can be used: an enabled proxy with
 * nowhere to go, which fails the connection (see connectOnInterface) rather than sending it out
 * directly — a download the user asked to proxy never leaves unproxied. */
const NO_HOST: ProxyConfig = { enabled: true, type: 'socks5', host: '', port: 0 }

interface Entry {
  id: string
  proxy: ProxyConfig
  failures: number
  /** How many times in a row it has gone down: sets how long the next one lasts. */
  cooldowns: number
  downUntil: number
}

interface Assignment {
  entry: Entry
  networkId: string
}

function usable(host: Socks5Host): boolean {
  return (
    host.enabled &&
    host.host.trim().length > 0 &&
    Number.isInteger(host.port) &&
    host.port >= 1 &&
    host.port <= 65535
  )
}

/**
 * The SOCKS5 servers downloads connect through, and who uses which.
 *
 * Every download connection (one StreamConnection, see routes.ts) asks for a host when it opens
 * a socket and tells how that went. Hosts are handed out so that each one carries about the same
 * number of connections — counted over every download, and within a network first, so that each
 * network's connections are spread over the hosts and not just the whole lot. A connection keeps
 * its host from one socket to the next, unless that host has gone down and another hasn't.
 */
export class Socks5Pool {
  private enabled = false
  private entries: Entry[] = []
  private byProxy = new Map<ProxyConfig, Entry>()
  private assigned = new Map<string, Assignment>()
  private signature = ''
  private rotation = 0

  /** Counts up whenever the settings change: a connection holding sockets opened under the
   * old ones drops them (see StreamConnection), so the new ones apply to it at once. */
  epoch = 0

  configure(settings: Socks5Settings | undefined): void {
    const enabled = settings?.enabled === true
    const hosts = (settings?.hosts ?? []).filter(usable)
    const signature = JSON.stringify([
      enabled,
      hosts.map((h) => [h.id, h.host.trim(), h.port, h.username ?? '', h.password ?? ''])
    ])
    if (signature === this.signature) return
    this.signature = signature
    this.enabled = enabled

    // Hosts that stay keep what they learned about their health.
    const previous = new Map(this.entries.map((entry) => [entry.id, entry]))
    this.entries = hosts.map((host) => {
      const proxy: ProxyConfig = {
        enabled: true,
        type: 'socks5',
        host: host.host.trim(),
        port: host.port,
        ...(host.username ? { username: host.username } : {}),
        ...(host.password ? { password: host.password } : {})
      }
      const before = previous.get(host.id)
      const same =
        before?.proxy.host === proxy.host &&
        before.proxy.port === proxy.port &&
        before.proxy.username === proxy.username &&
        before.proxy.password === proxy.password
      return {
        id: host.id,
        proxy,
        failures: same ? before.failures : 0,
        cooldowns: same ? before.cooldowns : 0,
        downUntil: same ? before.downUntil : 0
      }
    })
    this.byProxy = new Map(this.entries.map((entry) => [entry.proxy, entry]))
    // Everyone asks again, so a host that was added gets its share.
    this.assigned.clear()
    this.epoch++
  }

  /** Whether downloads go through the pool. */
  get active(): boolean {
    return this.enabled
  }

  /** The host for connection `id`, running on network `networkId`: the one with the fewest
   * connections on that network, then the fewest overall. Undefined when SOCKS5 is off. */
  acquire(id: string, networkId: string): ProxyConfig | undefined {
    if (!this.enabled) {
      this.assigned.delete(id)
      return undefined
    }
    if (this.entries.length === 0) return NO_HOST

    // A host that is down is skipped, but if every one is, they are all tried: the connection
    // fails by itself if it must, it doesn't leave unproxied.
    const now = Date.now()
    const up = this.entries.filter((entry) => entry.downUntil <= now)
    const candidates = up.length > 0 ? up : this.entries

    const current = this.assigned.get(id)
    if (current && current.networkId === networkId && candidates.includes(current.entry)) {
      return current.entry.proxy
    }
    this.assigned.delete(id)

    const onNetwork = new Map<Entry, number>()
    const overall = new Map<Entry, number>()
    for (const other of this.assigned.values()) {
      overall.set(other.entry, (overall.get(other.entry) ?? 0) + 1)
      if (other.networkId === networkId) {
        onNetwork.set(other.entry, (onNetwork.get(other.entry) ?? 0) + 1)
      }
    }
    // Ties go to whoever comes next in turn, so equal hosts take turns rather than the first one
    // taking them all.
    const start = this.rotation++ % candidates.length
    let best: Entry | undefined
    let bestKey: [number, number] = [Infinity, Infinity]
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[(start + i) % candidates.length]
      const key: [number, number] = [onNetwork.get(entry) ?? 0, overall.get(entry) ?? 0]
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        best = entry
        bestKey = key
      }
    }
    this.assigned.set(id, { entry: best!, networkId })
    return best!.proxy
  }

  /** How a connection through `proxy` (as acquire gave it) went. */
  report(proxy: ProxyConfig, ok: boolean): void {
    const entry = this.byProxy.get(proxy)
    if (!entry) return // The settings changed since: it's no longer a host.
    if (ok) {
      entry.failures = 0
      entry.cooldowns = 0
      entry.downUntil = 0
      return
    }
    if (++entry.failures < FAILURES_BEFORE_COOLDOWN) return
    entry.failures = 0
    entry.cooldowns++
    entry.downUntil =
      Date.now() + Math.min(COOLDOWN_MS * 2 ** (entry.cooldowns - 1), MAX_COOLDOWN_MS)
  }

  /** The connection is closed: its host has one fewer. */
  release(id: string): void {
    this.assigned.delete(id)
  }
}

/** The one pool, shared by every download. Configured from the saved settings (see ipc/handlers.ts). */
export const socks5Pool = new Socks5Pool()
