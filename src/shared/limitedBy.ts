import type { NetworkStatus } from './types'

// What holds a running download back, said in one line under its total speed (see
// DownloadingScreen). Picked in the main process, where the facts are, and sent as a code: the
// window words it. Only what is known for certain counts, never a guess from how fast it goes:
// a slow server with slow mode on isn't slow mode's doing unless slow mode actually held a read
// back.
//
// One reason at a time, the one the user can do most about first:
// - slow mode, or the speed limit over every download, held bytes back just now. Either caps the
//   whole download, so nothing below it would make it faster while it does.
// - one of the networks in use reached its data limit, or its own speed limit held it back.
// - one of them can’t reach the server, or kept failing there (failed), while others carry on.
//   With none carrying the download, the screen says what it is waiting for instead.
// - the drive can't save any faster (see DiskWatch in main/download/concurrency.ts).
// - the server sends the file over one connection only: no ranges, or no size. That is one
//   network, however many are on.
// - the server refused connections past a number while it served the others (see
//   ConcurrencyController in main/download/concurrency.ts).

/** One reason, as small as it can be: a code, and the network or number it is about. */
export type LimitedBy =
  | { reason: 'slow-mode' | 'speed-limit' | 'disk' | 'one-connection' }
  | {
      reason: 'data-limit' | 'network-speed-limit' | 'unreachable' | 'failed'
      /** A DownloadNetwork's id. */
      network: string
    }
  | { reason: 'server-connections'; connections: number }

/** What the main process knows about a running download, as of now. */
export interface LimitFacts {
  /** Slow mode, or the speed limit, held a read back just now; unset when neither did. */
  cap?: 'slow-mode' | 'speed-limit'
  /** The download's networks, in their order. `capped`: its own speed limit held it back. */
  networks: readonly { id: string; enabled: boolean; status: NetworkStatus; capped?: boolean }[]
  /** The drive can't keep up (HttpDownloadState.diskLimited). */
  disk?: boolean
  /** The server sends the file over one connection (see splittable in httpTransfer.ts). */
  oneConnection?: boolean
  /** The fewest streams the server accepts over a network in use, when it refused more and that
   * is what holds the network to its count. */
  serverConnections?: number
}

/** The one reason to show, or none. */
export function limitedBy(facts: LimitFacts): LimitedBy | undefined {
  const enabled = facts.networks.filter((network) => network.enabled)
  const carrying = enabled.filter((network) => network.status === 'on')
  // Nothing carrying it: not slow, stopped, and the screen says what it waits for.
  if (carrying.length === 0) return undefined
  if (facts.cap) return { reason: facts.cap }
  const dataLimit = enabled.find((network) => network.status === 'limit')
  if (dataLimit) return { reason: 'data-limit', network: dataLimit.id }
  const capped = carrying.find((network) => network.capped)
  if (capped) return { reason: 'network-speed-limit', network: capped.id }
  const unreachable = enabled.find((network) => network.status === 'unreachable')
  if (unreachable) return { reason: 'unreachable', network: unreachable.id }
  const failed = enabled.find((network) => network.status === 'failed')
  if (failed) return { reason: 'failed', network: failed.id }
  if (facts.disk) return { reason: 'disk' }
  if (facts.oneConnection) return { reason: 'one-connection' }
  if (facts.serverConnections !== undefined) {
    return { reason: 'server-connections', connections: facts.serverConnections }
  }
  return undefined
}

/** A reason the user sets in Speed & data limits: one a change there can bring or take away. */
export function fromLimits(reason: LimitedBy | undefined): boolean {
  return (
    reason?.reason === 'slow-mode' ||
    reason?.reason === 'speed-limit' ||
    reason?.reason === 'data-limit' ||
    reason?.reason === 'network-speed-limit'
  )
}

function same(a: LimitedBy | undefined, b: LimitedBy | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** How long a reason, or none, must hold before the line changes to it: long against a tick
 * (500 ms), so a reason coming and going from one look to the next never makes the line flicker,
 * and short enough that one which stays is soon said. */
export const LIMIT_SETTLE_MS = 3000

/** The reason shown, changed only once another has held for LIMIT_SETTLE_MS. No clock of its own:
 * each look brings the time. */
export class LimitReadout {
  shown: LimitedBy | undefined
  private next: LimitedBy | undefined
  private since = 0

  /** One look: what limitedBy says now. Says whether the reason shown changed. */
  update(reason: LimitedBy | undefined, now: number): boolean {
    if (same(reason, this.shown)) {
      this.next = this.shown
      return false
    }
    if (!same(reason, this.next)) {
      this.next = reason
      this.since = now
    }
    if (now - this.since < LIMIT_SETTLE_MS) return false
    this.shown = reason
    return true
  }

  /** Shows `reason` at once: what the user just changed (a limit) is no flicker. */
  adopt(reason: LimitedBy | undefined): boolean {
    this.next = reason
    if (same(reason, this.shown)) return false
    this.shown = reason
    return true
  }
}
