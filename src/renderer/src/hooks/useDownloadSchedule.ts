import { scheduleMessage, scheduleWindow } from '@shared/downloadSchedule'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'

export function useDownloadSchedule(): {
  schedule: ReturnType<typeof useAppStore.getState>['downloadSchedule']
  window: ReturnType<typeof scheduleWindow>
  message: string | null
} {
  const schedule = useAppStore((store) => store.downloadSchedule)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!schedule?.enabled) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [schedule?.enabled])
  return {
    schedule,
    window: scheduleWindow(schedule, now),
    message: scheduleMessage(schedule, now)
  }
}
