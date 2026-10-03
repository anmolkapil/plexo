import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { bitfieldOf, creditPiece, pickNetwork } from '../src/main/download/torrent/peers'

test.describe('torrent peers across networks', () => {
  test('a new peer goes to the network with the fewest, the first on a tie', () => {
    expect(pickNetwork([])).toBeNull()
    expect(
      pickNetwork([
        { id: 'wifi', peers: 3 },
        { id: 'usb', peers: 1 },
        { id: 'eth', peers: 1 }
      ])
    ).toBe('usb')
  })

  test('peers spread evenly when each new one takes the least loaded network', () => {
    const peers: Record<string, number> = { a: 0, b: 0, c: 0 }
    for (let added = 0; added < 30; added++) {
      const id = pickNetwork(Object.entries(peers).map(([id, count]) => ({ id, peers: count })))!
      peers[id]++
    }
    expect(peers).toEqual({ a: 10, b: 10, c: 10 })
  })

  test('a verified piece is credited in whole bytes that add up to its length', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom('a', 'b', 'c'), fc.nat({ max: 1 << 20 })),
        fc.integer({ min: 1, max: 1 << 22 }),
        (received, length) => {
          const shares = creditPiece(received, length, 'a')
          const values = Object.values(shares)
          expect(values.every((bytes) => Number.isInteger(bytes) && bytes >= 0)).toBe(true)
          expect(values.reduce((sum, bytes) => sum + bytes, 0)).toBe(length)
          // Only networks that delivered something are credited, unless nobody did.
          const delivered = Object.keys(received).filter((id) => received[id] > 0)
          expect(Object.keys(shares).sort()).toEqual(delivered.length ? delivered.sort() : ['a'])
        }
      )
    )
    expect(creditPiece({ a: 3, b: 1 }, 100, 'a')).toEqual({ a: 75, b: 25 })
    expect(creditPiece({}, 64, 'eth')).toEqual({ eth: 64 })
  })

  test('the starting bitfield has one bit per piece, the first piece highest', () => {
    expect([...bitfieldOf([true, false, false, false, false, false, false, true, true])]).toEqual([
      0b10000001, 0b10000000
    ])
    expect(bitfieldOf([])).toHaveLength(0)
  })
})
