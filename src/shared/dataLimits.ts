import type { DataLimitPeriod } from './types'

export const DATA_LIMIT_PERIODS: { value: DataLimitPeriod; label: string; usage: string }[] = [
  { value: 'day', label: 'Day', usage: 'today' },
  { value: 'week', label: 'Week', usage: 'this week' },
  { value: 'month', label: 'Month', usage: 'this month' }
]

/** Calendar boundaries in the same local time zone used by the usage counter. Weeks start Monday. */
export function dataPeriodKey(period: DataLimitPeriod, time: number): string {
  const date = new Date(time)
  if (period === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
  return period === 'month' ? month : `${month}-${String(date.getDate()).padStart(2, '0')}`
}

export function nextDataReset(period: DataLimitPeriod, time: number): Date {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  if (period === 'month') date.setMonth(date.getMonth() + 1, 1)
  else date.setDate(date.getDate() + (period === 'day' ? 1 : 7 - ((date.getDay() + 6) % 7)))
  return date
}

export function dataUsageLabel(period: DataLimitPeriod): string {
  return DATA_LIMIT_PERIODS.find((entry) => entry.value === period)!.usage
}
