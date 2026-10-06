import { useAppStore } from '../store/useAppStore'
import { formatSpeed } from '../utils/format'

/** formatSpeed in the unit picked in the footer; re-renders the caller when it changes. */
export function useFormatSpeed(): (bytesPerSec: number) => string {
  const unit = useAppStore((store) => store.speedUnit)
  return (bytesPerSec) => formatSpeed(bytesPerSec, unit)
}
