import type { DownloadSchedule } from './types'

export const DEFAULT_DOWNLOAD_SCHEDULE: DownloadSchedule = {
  enabled: false,
  startMinute: 0,
  endMinute: 7 * 60,
  days: [0, 1, 2, 3, 4, 5, 6]
}

export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function validSchedule(value: unknown): value is DownloadSchedule {
  if (typeof value !== 'object' || value === null) return false
  const schedule = value as DownloadSchedule
  if (
    typeof schedule.enabled !== 'boolean' ||
    ![schedule.startMinute, schedule.endMinute].every(
      (minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440
    ) ||
    schedule.startMinute === schedule.endMinute ||
    !Array.isArray(schedule.days) ||
    schedule.days.length === 0 ||
    !schedule.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  )
    return false
  if (schedule.endDate !== undefined) {
    if (typeof schedule.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.endDate))
      return false
    const date = new Date(`${schedule.endDate}T12:00:00`)
    if (!Number.isFinite(date.getTime()) || localDate(date) !== schedule.endDate) return false
  }
  return true
}

export interface ScheduleWindow {
  allowed: boolean
  nextStart?: number
  endsAt?: number
  expired?: boolean
}

/** Calendar arithmetic, rather than 24-hour offsets, keeps local times across DST changes.
 * Overnight windows belong to the day they start; the end date includes that whole window. */
export function scheduleWindow(
  schedule: DownloadSchedule | undefined,
  now = Date.now()
): ScheduleWindow {
  if (!schedule?.enabled) return { allowed: true }
  if (!validSchedule(schedule)) return { allowed: false }
  const today = new Date(now)
  let nextStart: number | undefined
  for (let offset = -1; offset <= 7; offset++) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset)
    if (!schedule.days.includes(start.getDay())) continue
    if (schedule.endDate && localDate(start) > schedule.endDate) continue
    start.setHours(Math.floor(schedule.startMinute / 60), schedule.startMinute % 60, 0, 0)
    const end = new Date(start)
    if (schedule.endMinute < schedule.startMinute) end.setDate(end.getDate() + 1)
    end.setHours(Math.floor(schedule.endMinute / 60), schedule.endMinute % 60, 0, 0)
    if (now >= start.getTime() && now < end.getTime()) {
      return { allowed: true, endsAt: end.getTime() }
    }
    if (start.getTime() > now && nextStart === undefined) nextStart = start.getTime()
  }
  return { allowed: false, nextStart, expired: nextStart === undefined }
}

export function scheduleTime(minute: number): string {
  const date = new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60)
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function scheduleMessage(
  schedule: DownloadSchedule | undefined,
  now = Date.now()
): string | null {
  if (!schedule?.enabled) return null
  const window = scheduleWindow(schedule, now)
  if (window.allowed && window.endsAt) {
    return `Downloads stop at ${new Date(window.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  if (window.nextStart) {
    const next = new Date(window.nextStart)
    const day =
      localDate(next) === localDate(new Date(now))
        ? 'today'
        : next.toLocaleDateString([], { weekday: 'short' })
    return `Waiting until ${scheduleTime(schedule.startMinute)} ${day}`
  }
  return window.expired ? 'Schedule ended · downloads waiting' : 'Schedule needs attention'
}
