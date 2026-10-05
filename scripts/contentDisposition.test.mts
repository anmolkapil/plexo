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
  assert.equal(parseContentDispositionFilename(d), 'café.txt')
})

test('ISO-8859-1 filename* still wins over RFC 2047 filename', () => {
  const d =
    'attachment; filename="=?UTF-8?B?dGVzdC50eHQ=?="; filename*=iso-8859-1\'en\'%A3%20rates.txt'
  assert.equal(parseContentDispositionFilename(d), '£ rates.txt')
})

test('plain filenames are unchanged', () => {
  assert.equal(parseContentDispositionFilename('attachment; filename="report.pdf"'), 'report.pdf')
  assert.equal(decodeRfc2047Filename('report.pdf'), 'report.pdf')
})
