import { expect, test } from '@playwright/test'
import {
  describeError,
  formatBytes,
  formatEta,
  formatPercent,
  formatSpeed,
  speedTicks
} from '../src/renderer/src/utils/format'

const GiB = 1024 ** 3
const MiB = 1024 ** 2

test.describe('formatting @smoke', () => {
  test('a percentage reads 100 only once every byte is in', () => {
    expect(formatPercent(10 * GiB - 5 * MiB, 10 * GiB)).toBe(99)
    expect(formatPercent(999, 1000)).toBe(99)
    expect(formatPercent(1000, 1000)).toBe(100)
    expect(formatPercent(994, 1000)).toBe(99)
    expect(formatPercent(500, 1000)).toBe(50)
    expect(formatPercent(0, 0)).toBe(0)
  })

  test('less than a byte a second is still in bytes', () => {
    expect(formatBytes(0.5)).toBe('1 B')
    expect(formatSpeed(1 / 3, 'bytes')).toBe('0 B/s')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  test('a speed axis for a sub-byte speed is finite', () => {
    const { top, ticks } = speedTicks(0.5, 'bytes')
    expect(Number.isFinite(top)).toBe(true)
    expect(top).toBeGreaterThanOrEqual(0.5)
    expect(ticks.length).toBeGreaterThan(0)
    for (const tick of ticks) expect(tick.label).toMatch(/ B\/s$/)
  })

  test('a countdown never reads 60s', () => {
    expect(formatEta(0.2)).toBe('1s')
    expect(formatEta(58.2)).toBe('59s')
    expect(formatEta(59.01)).toBe('1m 0s')
    expect(formatEta(59.5)).toBe('1m 0s')
    expect(formatEta(61)).toBe('1m 1s')
  })

  test('a name with TLS or SSL in it isn’t read as a certificate problem', () => {
    const certificate = /security certificate/
    expect(describeError(new Error('unable to verify the first certificate'))).toMatch(certificate)
    expect(describeError(new Error('certificate has expired'))).toMatch(certificate)
    expect(
      describeError(
        new Error('Client network socket disconnected before secure TLS connection was established')
      )
    ).toMatch(certificate)
    expect(describeError(new Error('Windows can’t save a file named Thesis: TLS 1.3.pdf'))).toBe(
      'Windows can’t save a file named Thesis: TLS 1.3.pdf'
    )
    expect(
      describeError(new Error('No selected network has an address compatible with ssl.example.com'))
    ).toBe('No selected network has an address compatible with ssl.example.com')
  })
})
