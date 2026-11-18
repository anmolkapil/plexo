import { expect, test } from '@playwright/test'
import { indexerError, parseNzb, type ParsedNzb } from '../src/main/download/nzb/nzbFile'

// An NZB comes from anywhere: a link, an indexer, a file dropped on the window. Reading one takes
// time that grows with its size, never with the square of it, however it's made — and every NZB
// that was read before is read the same way.

const HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">'

const parse = (xml: string): ParsedNzb => parseNzb(Buffer.from(xml))

/** One file of one article, as a poster's NZB lists it. */
const file = (subject: string, id = 'a@b'): string =>
  `<file subject="${subject}"><segments><segment bytes="10" number="1">${id}</segment></segments></file>`

/** What parsing `xml` comes to, and how long it took. */
function timed(xml: string): { outcome: string; ms: number } {
  const started = performance.now()
  let outcome: string
  try {
    outcome = `${parse(xml).files.length} files`
  } catch (error) {
    outcome = (error as Error).message
  }
  return { outcome, ms: performance.now() - started }
}

// Each of these took from seconds to many minutes before: the work grew with the square of the
// repeated part. Read in one pass, each takes milliseconds; the bound leaves room for a slow
// machine.
const BOUND_MS = 2000
const pathological: Record<string, string> = {
  'tags never closed': HEAD + '<file '.repeat(200_000),
  'elements never closed': HEAD + '<file a="1">'.repeat(200_000),
  'quotes never closed': HEAD + '<file "\'<file \'"'.repeat(100_000),
  'comments never closed': HEAD + '<!--'.repeat(200_000),
  'CDATA never closed': HEAD + '<![CDATA['.repeat(200_000),
  'an attribute name with no value': HEAD + `<file ${'a'.repeat(200_000)}>${file('x')}</nzb>`,
  'a subject of dots and spaces': HEAD + file(`${'. '.repeat(200_000)}x`) + '</nzb>',
  'a subject of spaces': HEAD + file(`a${' '.repeat(200_000)}b`) + '</nzb>',
  'a name far too long': HEAD + file('n'.repeat(200_000)) + '</nzb>',
  'many files of one name': HEAD + file('same.bin').repeat(20_000) + '</nzb>'
}

test.describe('reading an NZB', () => {
  for (const [name, xml] of Object.entries(pathological)) {
    test(`takes time in step with its size: ${name}`, () => {
      const { ms } = timed(xml)
      expect(ms).toBeLessThan(BOUND_MS)
    })
  }

  test('an indexer’s answer full of unclosed error tags is read just as quickly', () => {
    const started = performance.now()
    expect(indexerError('<error '.repeat(9_000))).toBeNull()
    expect(performance.now() - started).toBeLessThan(BOUND_MS)
  })

  test('namespaced and upper-case tags, either quote style, and a `>` inside a value', () => {
    const nzb = parse(
      HEAD.replace('<nzb', '<nzb:nzb') +
        `<nzb:head><nzb:meta type='password'>open &amp; shut</nzb:meta></nzb:head>` +
        `<nzb:file poster='a <b@c>' subject='[1/2] - "Clip > Cut.mkv" yEnc (1/2)'><nzb:segments>` +
        `<nzb:segment bytes='5' number='2'>two@x</nzb:segment >` +
        `<nzb:segment bytes="7" number="1">one@x</nzb:segment>` +
        `</nzb:segments></nzb:file>` +
        `<FILE SUBJECT="Notes.txt yEnc (1/1)"><SEGMENTS><SEGMENT NUMBER="1">n@x</SEGMENT></SEGMENTS></FILE>` +
        '</nzb:nzb>'
    )
    expect(nzb.password).toBe('open & shut')
    expect(nzb.files).toEqual([
      {
        name: 'Clip _ Cut.mkv',
        segments: [
          { number: 1, bytes: 7, messageId: 'one@x' },
          { number: 2, bytes: 5, messageId: 'two@x' }
        ]
      },
      { name: 'Notes.txt', segments: [{ number: 1, bytes: 1, messageId: 'n@x' }] }
    ])
  })

  test('comments are skipped, CDATA and entities read, self-closing tags hold nothing', () => {
    const nzb = parse(
      HEAD +
        `<!-- ${file('Ghost.bin')} -->` +
        '<file subject="Empty.bin"/>' +
        `<file subject="&quot;Data &amp; more.bin&quot; yEnc (1/1)"><segments>` +
        '<segment number="1"/>' +
        '<segment number="2"><![CDATA[<cd@x>]]></segment>' +
        '<segment number="3">&lt;ent@x&gt;</segment>' +
        '</segments></file></nzb>'
    )
    expect(nzb.files).toEqual([
      {
        name: 'Data & more.bin',
        segments: [
          { number: 2, bytes: 1, messageId: 'cd@x' },
          { number: 3, bytes: 1, messageId: 'ent@x' }
        ]
      }
    ])
  })

  test('a file cut off part way keeps the files that came whole', () => {
    const whole = file('First.rar', 'one@x')
    const nzb = parse(HEAD + whole + file('Second.rar', 'two@x').slice(0, 60))
    expect(nzb.files.map((entry) => entry.name)).toEqual(['First.rar'])
  })

  test('a file whose subject leaves a quote open is passed over, and the next ones are read', () => {
    const nzb = parse(
      HEAD +
        '<file subject="Broken><segments><segment number="1">x@x</segment></segments></file>' +
        file('Second.rar', 'two@x') +
        file('Third.rar', 'three@x') +
        '</nzb>'
    )
    expect(nzb.files.map((entry) => entry.name)).toEqual(['Second.rar', 'Third.rar'])
  })

  test('names: taken from the subject, made safe, unique, and no longer than 255 bytes', () => {
    const long = 'é'.repeat(200)
    const nzb = parse(
      HEAD +
        file('[1/4] - &quot;Movie.part1.rar&quot; yEnc (1/50)') +
        file('movie.part1.rar yEnc (2/50)') +
        file('Movie.part1.rar (3/50)') +
        file(`${long}.mkv yEnc (1/1)`) +
        file('Trailing dots... yEnc (1/1)') +
        file('CON.txt') +
        '</nzb>'
    )
    expect(nzb.files.map((entry) => entry.name)).toEqual([
      '_CON.txt',
      `${'é'.repeat(125)}.mkv`,
      'Movie.part1.rar',
      'movie.part1 (2).rar',
      'Movie.part1 (3).rar',
      'Trailing dots'
    ])
  })
})
