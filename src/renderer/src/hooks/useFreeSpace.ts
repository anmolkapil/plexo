import { useEffect, useState } from 'react'

export const FREE_SPACE_POLL_MS = 30_000

/**
 * Polls the available free space on the drive hosting `dir`.
 * Returns null while loading or when `dir` is empty/unavailable.
 * Resets to null whenever `dir` changes to prevent showing stale values.
 */
export function useFreeSpace(dir: string | null | undefined): number | null {
  const [prevDir, setPrevDir] = useState(dir)
  const [free, setFree] = useState<number | null>(null)

  if (dir !== prevDir) {
    setPrevDir(dir)
    setFree(null)
  }

  useEffect(() => {
    if (!dir) return

    let disposed = false
    const check = (): void => {
      void window.plexo
        .freeSpace(dir)
        .then((bytes) => {
          if (!disposed) setFree(bytes)
        })
        .catch(() => {
          if (!disposed) setFree(null)
        })
    }

    check()
    const timer = setInterval(check, FREE_SPACE_POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [dir])

  return free
}
