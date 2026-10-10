import { expect, test } from '@playwright/test'
import {
  DEFAULT_DOWNLOAD_SCHEDULE,
  scheduleWindow,
  validSchedule
} from '../src/shared/downloadSchedule'
import type { DownloadSchedule } from '../src/shared/types'

const schedule: DownloadSchedule = { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true }
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 9, day, hour, minute).getTime()

test('the start is inclusive and the stop is exclusive', () => {
  expect(scheduleWindow(schedule, at(10, 0)).allowed).toBe(true)
  expect(scheduleWindow(schedule, at(10, 6, 59)).allowed).toBe(true)
  expect(scheduleWindow(schedule, at(10, 7)).allowed).toBe(false)
  expect(scheduleWindow(schedule, at(10, 7)).nextStart).toBe(at(11, 0))
  expect(scheduleWindow(undefined, at(10, 12)).allowed).toBe(true)
  expect(scheduleWindow({ ...schedule, enabled: false }, at(10, 12)).allowed).toBe(true)
})

test('overnight windows belong to their starting weekday', () => {
  const friday = { ...schedule, startMinute: 22 * 60, days: [5] }
  expect(scheduleWindow(friday, at(9, 22)).allowed).toBe(true)
  expect(scheduleWindow(friday, at(10, 6)).allowed).toBe(true)
  expect(scheduleWindow(friday, at(10, 7)).allowed).toBe(false)
  expect(scheduleWindow(friday, at(10, 22)).nextStart).toBe(at(16, 22))
})

test('the final overnight window finishes, then expiration keeps downloads blocked', () => {
  const final = { ...schedule, startMinute: 22 * 60, endDate: '2026-10-09' }
  expect(scheduleWindow(final, at(10, 6)).allowed).toBe(true)
  expect(scheduleWindow(final, at(10, 7))).toEqual({
    allowed: false,
    nextStart: undefined,
    expired: true
  })
  expect(scheduleWindow(final, at(11, 22)).allowed).toBe(false)
})

test('invalid schedules fail closed', () => {
  for (const patch of [
    { days: [] },
    { days: [7] },
    { days: ['1'] },
    { startMinute: -1 },
    { endMinute: 1440 },
    { endMinute: 0 },
    { startMinute: 0.5 },
    { endDate: '2026-02-30' },
    { endDate: 'bad' }
  ]) {
    const invalid = { ...schedule, ...patch } as DownloadSchedule
    expect(validSchedule(invalid)).toBe(false)
    expect(scheduleWindow(invalid, at(10, 0)).allowed).toBe(false)
  }
})

test('local wall-clock windows survive daylight saving changes', () => {
  const previous = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    for (const date of [
      [2026, 2, 8],
      [2026, 10, 1]
    ]) {
      const [year, month, day] = date
      const now = new Date(year, month, day, 6, 59).getTime()
      expect(scheduleWindow(schedule, now).endsAt).toBe(new Date(year, month, day, 7).getTime())
      expect(scheduleWindow(schedule, new Date(year, month, day, 7).getTime()).allowed).toBe(false)
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
