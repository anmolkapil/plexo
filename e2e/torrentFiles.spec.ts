import { expect, test } from '@playwright/test'
import fc from 'fast-check'
import { chosenFiles, wantedPieces } from '../src/main/download/torrent/files'

test.describe('choosing a torrent’s files', () => {
  test('a piece is wanted exactly when a byte of a chosen file is in it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 3000 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 16, max: 2048 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        (lengths, pieceLength, picks) => {
          const files = lengths.map((length) => ({ length }))
          const chosen = new Set(lengths.flatMap((_, index) => (picks[index] ? [index] : [])))
          const wanted = wantedPieces(files, pieceLength, chosen)

          const total = lengths.reduce((sum, length) => sum + length, 0)
          expect(wanted).toHaveLength(Math.ceil(total / pieceLength))
          // The plain definition: some byte of the piece belongs to a chosen file.
          wanted.forEach((isWanted, piece) => {
            let offset = 0
            const needed = lengths.some((length, index) => {
              const start = offset
              offset += length
              // An empty file has no byte, so it needs no piece.
              return (
                chosen.has(index) &&
                length > 0 &&
                start < (piece + 1) * pieceLength &&
                start + length > piece * pieceLength
              )
            })
            expect(isWanted, `piece ${piece}`).toBe(needed)
          })
        }
      )
    )
  })

  test('what the window asks for: all, some, none, or something that isn’t there', () => {
    expect(chosenFiles(undefined, 3)).toBeNull()
    expect(chosenFiles([0, 1, 2], 3)).toBeNull()
    expect(chosenFiles([2, 0, 0], 3)).toEqual(new Set([0, 2]))
    expect(() => chosenFiles([], 3)).toThrow(/at least one/)
    expect(() => chosenFiles([3], 3)).toThrow(/isn’t in it/)
    expect(() => chosenFiles([1.5], 3)).toThrow(/isn’t in it/)
  })
})
