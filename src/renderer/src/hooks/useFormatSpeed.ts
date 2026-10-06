import { useAppStore } from '../store/useAppStore'
import { formatSpeed, formatSpeedLimit } from '../utils/format'

/** formatSpeed in the unit picked in the footer; re-renders the caller when it changes. */
export function useFormatSpeed(): (bytesPerSec: number) => string {
  const unit = useAppStore((store) => store.speedUnit)
  return (bytesPerSec) => formatSpeed(bytesPerSec, unit)
}

/** formatSpeedLimit in the unit picked in the footer: for limits, which read as round figures. */
export function useFormatSpeedLimit(): (bytesPerSec: number) => string {
  const unit = useAppStore((store) => store.speedUnit)
  return (bytesPerSec) => formatSpeedLimit(bytesPerSec, unit)
}
