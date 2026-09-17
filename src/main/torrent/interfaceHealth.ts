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
 * Tracks which of the selected networks can actually reach the swarm, so peers aren't spent
 * on networks that cannot dial them.
 *
 * Plexo lists every non-loopback IPv4 interface as a network a download can use, which is
 * right for HTTP — a chunk that fails there is simply retried. Torrents are less forgiving:
 * peers are a finite, perishable resource, and a machine running Docker, WSL, a VM or a VPN
 * can easily present four unroutable adapters alongside one real one. Dialing round-robin
 * across all of them burns four fifths of the swarm before the real network gets a turn.
 */
export class InterfaceHealth {
  private readonly interfaces: TorrentInterface[]
  private readonly strikes = new Map<string, number>()
  private readonly retired = new Set<string>()
  private rotation = 0

  constructor(interfaces: TorrentInterface[]) {
    this.interfaces = interfaces
  }

  /** The networks still worth dialing from. Never empty: if every one has been retired, they
   * are all given another chance rather than leaving the download with nowhere to go. */
  usable(): TorrentInterface[] {
    const usable = this.interfaces.filter((entry) => !this.retired.has(entry.id))
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
    if (!this.retired.has(interfaceId)) return false
    // If everything has been retired, `usable` hands them all back — so nothing is retired
    // any more, and this has to agree with that rather than sideline every network at once.
    return this.interfaces.some((entry) => !this.retired.has(entry.id))
  }

  /**
   * Records a failed dial. Returns true when the interface was at fault, which tells the
   * caller the peer itself is still worth trying from somewhere else.
   */
  noteFailure(interfaceId: string, error?: Error): boolean {
    if (!isUnreachableFromInterface(error)) return false

    const strikes = (this.strikes.get(interfaceId) ?? 0) + 1
    this.strikes.set(interfaceId, strikes)

    // Never retire the last network standing — a download with no interface at all is a
    // worse outcome than one making slow progress over a questionable link.
    const remaining = this.interfaces.filter(
      (entry) => !this.retired.has(entry.id) && entry.id !== interfaceId
    )
    if (strikes >= UNREACHABLE_STRIKES && remaining.length > 0) {
      this.retired.add(interfaceId)
    }
    return true
  }

  /** A connection got through, so whatever earlier failures this network had weren't its fault. */
  noteSuccess(interfaceId: string): void {
    this.strikes.delete(interfaceId)
    this.retired.delete(interfaceId)
  }
}
