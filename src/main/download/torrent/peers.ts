// How a torrent's peers are spread over the networks, and how their bytes are credited back.
// Pure: torrentTransfer.ts feeds these what webtorrent reports.

/** A network that can carry a connection to the peer at hand (one of its addresses has the peer's
 * IP family), with its peers: connected, and being dialled. */
export interface NetworkLoad {
  id: string
  peers: number
}

/**
 * The network a new peer connects through: the one carrying the fewest peers, the first on a tie.
 * A faster network then gets more of the torrent on its own, because each of its peers keeps a
 * full queue of requests answered sooner.
 */
// ponytail: fewest-peers-first; weight by measured speed per network if one is seen starving.
export function pickNetwork(networks: readonly NetworkLoad[]): string | null {
  let best: NetworkLoad | null = null
  for (const network of networks) if (!best || network.peers < best.peers) best = network
  return best?.id ?? null
}

/**
 * Splits a verified piece's length between the networks that delivered it, in proportion to what
 * each received for it (a piece can arrive partly over each). Whole bytes that add up to `length`
 * exactly; what rounding leaves goes to the largest share. Bytes nobody is known to have
 * delivered — a piece found already on disk — go to `fallback`.
 */
export function creditPiece(
  received: Readonly<Record<string, number>>,
  length: number,
  fallback: string
): Record<string, number> {
  const entries = Object.entries(received).filter(([, bytes]) => bytes > 0)
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0)
  if (total === 0) return { [fallback]: length }
  const shares: Record<string, number> = {}
  let given = 0
  let largest = entries[0][0]
  for (const [id, bytes] of entries) {
    shares[id] = Math.floor((length * bytes) / total)
    given += shares[id]
    if (bytes > received[largest]) largest = id
  }
  shares[largest] += length - given
  return shares
}

/** The pieces in `done`, as webtorrent takes a starting bitfield: one bit each, first piece in
 * the first byte's highest bit. */
export function bitfieldOf(done: readonly boolean[]): Uint8Array {
  const bits = new Uint8Array(Math.ceil(done.length / 8))
  done.forEach((isDone, index) => {
    if (isDone) bits[index >> 3] |= 0x80 >> (index & 7)
  })
  return bits
}
