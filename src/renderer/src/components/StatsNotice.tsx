import { PRIVACY_URL } from '@shared/stats'
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'

/** Left on screen this long, the notice counts as read, the same as OK. Only time the window is
 * visible counts: hidden in the tray or minimized, no one is reading it. */
const READ_AFTER_MS = 60_000

/** Shown on a fresh install, and to everyone updating to the version that added the stats,
 * before any are sent. Not in the way of a download: it sits over the bottom corner. Nothing is
 * sent until OK, or a minute of it on screen — time to turn them off first. Closed without
 * either, it comes back next time. */
export function StatsNotice(): React.JSX.Element | null {
  const due = useAppStore((store) => store.stats.noticeDue)
  const setShareStats = useAppStore((store) => store.setShareStats)
  const [open, setOpen] = useState(due)
  const read = useRef(false)
  const markRead = (): void => {
    if (read.current) return
    read.current = true
    useAppStore.getState().statsNoticeSeen()
  }

  useEffect(() => {
    if (!open) return
    let left = READ_AFTER_MS
    let since = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const update = (): void => {
      if (document.visibilityState === 'visible') {
        if (timer) return
        since = Date.now()
        timer = setTimeout(markRead, left)
      } else if (timer) {
        clearTimeout(timer)
        timer = undefined
        left -= Date.now() - since
      }
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      clearTimeout(timer)
    }
  }, [open])

  if (!open) return null
  return (
    <section
      aria-label="Anonymous stats"
      className="fixed right-4 bottom-14 z-40 flex w-[min(360px,calc(100%-2rem))] flex-col gap-3 rounded-xl bg-popover p-4 text-[13px] leading-snug text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-200 animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <p>
        Plexo sends anonymous stats — app version, system, and whether downloads finish or why they
        fail — to help fix problems. It never sends links, file names or your IP address.
      </p>
      <div className="flex items-center gap-2">
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="mr-auto text-[12.5px] text-[var(--text-secondary)] underline"
        >
          What’s sent
        </a>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setShareStats(false)
            setOpen(false)
          }}
        >
          Turn off
        </Button>
        <Button
          size="sm"
          onClick={() => {
            markRead()
            useAppStore.setState((store) => ({ stats: { ...store.stats, noticeDue: false } }))
            setOpen(false)
          }}
        >
          OK
        </Button>
      </div>
    </section>
  )
}
