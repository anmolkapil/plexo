import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeRfc2047Filename,
  parseContentDispositionFilename
} from '../src/main/download/contentDisposition.ts'

test('RFC 2047 Base64 filename is decoded', () => {
  // "test.txt" in UTF-8 base64
  const d = 'attachment; filename="=?UTF-8?B?dGVzdC50eHQ=?="'
  assert.equal(parseContentDispositionFilename(d), 'test.txt')
})

test('RFC 2047 Q-encoding filename is decoded', () => {
  const d = 'attachment; filename="=?UTF-8?Q?caf=C3=A9.txt?="'
  assert.equal(parseContentDispositionFilename(d), 'caf\u00e9.txt')
})

test('ISO-8859-1 filename* still wins over RFC 2047 filename', () => {
  const d =
    "attachment; filename=\"=?UTF-8?B?dGVzdC50eHQ=?=\"; filename*=iso-8859-1'en'%A3%20rates.txt"
  assert.equal(parseContentDispositionFilename(d), '\u00a3 rates.txt')
})

test('plain filenames are unchanged', () => {
  assert.equal(parseContentDispositionFilename('attachment; filename="report.pdf"'), 'report.pdf')
  assert.equal(decodeRfc2047Filename('report.pdf'), 'report.pdf')
})

test('whitespace is kept in mixed plaintext + encoded-word filenames', () => {
  const name = 'quarterly report =?UTF-8?Q?caf=C3=A9?= final.txt'
  assert.equal(decodeRfc2047Filename(name), 'quarterly report caf\u00e9 final.txt')
})

test('whitespace between adjacent encoded-words is discarded', () => {
  assert.equal(
    decodeRfc2047Filename('=?UTF-8?Q?caf=C3=A9?= =?UTF-8?Q?_final.txt?='),
    'caf\u00e9 final.txt'
  )
})

test('malformed Base64 encoded-word is left unchanged', () => {
  const name = '=?UTF-8?B?!!!!?='
  assert.equal(decodeRfc2047Filename(name), name)
})

test('unsupported charset encoded-word is left unchanged', () => {
  const name = '=?x-unknown?B?Y2Fm6S50eHQ=?='
  assert.equal(decodeRfc2047Filename(name), name)
})
