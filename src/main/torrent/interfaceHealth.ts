export interface TorrentInterface {
  id: string
  /** Local IP that peer sockets bind to. */
  address: string
}

/**
 * Errors that mean *this interface* has no route to the peer, rather than that the peer is
 * bad. A virtual adapter — a VM host-only network, WSL's vEthernet, an idle VPN — has a
 * local IPv4 address and so looks like a usable network, but binding an outbound socket to
 * it fails instantly for every public address on the internet.
 */
function isUnreachableFromInterface(error?: Error): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return (
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'EADDRNOTAVAIL' ||
    code === 'EINVAL'
  )
}

/**
 * One strike isn't proof: a tracker can hand out a peer on a private range that no interface
 * can reach, and blaming the interface for that would retire a working network. Repeated
 * failures with no successful connection in between are what distinguish a dead adapter.
 */
const UNREACHABLE_STRIKES = 3

/**
 * How close together strikes must land to count as evidence about the adapter.
 *
 * Counting them cumulatively is what made this misfire. Tracker peer lists routinely carry
 * addresses nothing can reach — a client that announced its LAN IP, a CGNAT range — and each
 * one is an unreachable error charged to whichever network happened to draw it. Over a long
 * download a healthy network collects three of those by simple accumulation and is retired
 * for something that was never its fault. A genuinely dead adapter is not subtle: it fails
 * every dial it is handed, milliseconds apart, so a window this short still catches it on
 * the first burst while letting scattered bad peers age out.
 */
const STRIKE_WINDOW_MS = 20_000

/**
 * Retirement is a cooldown, never a verdict.
 *
 * The exit from retirement is `noteSuccess`, which only fires from a live connection on that
 * network — and a retired network is never dialed, so it can never produce one. Retiring
 * permanently therefore meant a network could be removed from a download by three unlucky
 * peers and had no way back for the rest of the run, which is most of why a torrent would
 * quietly end up on one network. Letting it back on probation costs a few peers when the
 * adapter really is dead; the backoff is what keeps that cost bounded.
 */
const RETIREMENT_BASE_MS = 30_000
const RETIREMENT_MAX_MS = 5 * 60_000

interface InterfaceState {
  /** Unreachable dials inside the current window. */
  strikes: number
  lastStrikeAt: number
  /** When this network comes back off probation; 0 when it isn't retired. */
  retiredUntil: number
  /** Consecutive retirements, which is what the probation backs off against. */
  retirements: number
}

/**
 * Tracks which of the selected networks can actually reach the swarm, so peers aren't spent
 * on networks that cannot dial them.
 *
 * Plexo lists every non-loopback IPv4 interface as a network a download can use, which is
 * right for HTTP — a chunk that fails there is simply retried. Torrents are less forgiving:
 * a machine running Docker, WSL, a VM or a VPN can easily present four unroutable adapters
 * alongside one real one, and dialing round-robin across all of them wastes most of a dial
 * budget before the real network gets a turn.
 *
 * The balance to strike is that sidelining a network is also how multi-network downloading
 * silently stops working, so every judgement here is timed and reversible rather than final.
 */
export class InterfaceHealth {
  private readonly interfaces: TorrentInterface[]
  private readonly states = new Map<string, InterfaceState>()
  private rotation = 0

  constructor(interfaces: TorrentInterface[]) {
    this.interfaces = interfaces
  }

  private stateFor(interfaceId: string): InterfaceState {
    let state = this.states.get(interfaceId)
    if (!state) {
      state = { strikes: 0, lastStrikeAt: 0, retiredUntil: 0, retirements: 0 }
      this.states.set(interfaceId, state)
    }
    return state
  }

  private isCoolingDown(interfaceId: string, now: number): boolean {
    return this.stateFor(interfaceId).retiredUntil > now
  }

  /** The networks still worth dialing from. Never empty: if every one is cooling down, they
   * are all given another chance rather than leaving the download with nowhere to go. */
  usable(): TorrentInterface[] {
    const now = Date.now()
    const usable = this.interfaces.filter((entry) => !this.isCoolingDown(entry.id, now))
    return usable.length > 0 ? usable : this.interfaces
  }

  /** The next network to dial from, cycling through the usable ones. */
  next(): TorrentInterface | null {
    const usable = this.usable()
    if (usable.length === 0) return null
    const chosen = usable[this.rotation % usable.length]
    this.rotation += 1
    return chosen
  }

  isRetired(interfaceId: string): boolean {
    const now = Date.now()
    if (!this.isCoolingDown(interfaceId, now)) return false
    // If everything is cooling down, `usable` hands them all back — so nothing is retired
    // any more, and this has to agree with that rather than sideline every network at once.
    return this.interfaces.some((entry) => !this.isCoolingDown(entry.id, now))
  }

  /**
   * Records a failed dial. Returns true when the interface was at fault, which tells the
   * caller the peer itself is still worth trying from somewhere else.
   */
  noteFailure(interfaceId: string, error?: Error): boolean {
    if (!isUnreachableFromInterface(error)) return false

    const now = Date.now()
    const state = this.stateFor(interfaceId)

    // Out of window means the previous strikes were unrelated bad luck, not a pattern.
    state.strikes = now - state.lastStrikeAt > STRIKE_WINDOW_MS ? 1 : state.strikes + 1
    state.lastStrikeAt = now
    if (state.strikes < UNREACHABLE_STRIKES) return true

    // Never sideline the last network standing — a download with no interface at all is a
    // worse outcome than one making slow progress over a questionable link.
    const remaining = this.interfaces.filter(
      (entry) => entry.id !== interfaceId && !this.isCoolingDown(entry.id, now)
    )
    if (remaining.length === 0) return true

    state.strikes = 0
    state.retirements += 1
    state.retiredUntil =
      now + Math.min(RETIREMENT_BASE_MS * 2 ** (state.retirements - 1), RETIREMENT_MAX_MS)
    return true
  }

  /** A connection got through, so whatever earlier failures this network had weren't its
   * fault — including the ones that retired it, so the backoff starts over too. */
  noteSuccess(interfaceId: string): void {
    this.states.set(interfaceId, {
      strikes: 0,
      lastStrikeAt: 0,
      retiredUntil: 0,
      retirements: 0
    })
  }
}
