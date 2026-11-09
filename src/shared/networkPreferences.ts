import type { NetworkPreferences } from './types'

/** Moves what's saved under a network's device name to its id, for a network whose id has since
 * stopped being that name (a USB adapter is now known by its serial), so its name, limits and
 * proxy aren't lost. Nothing moves onto an id that already has settings. Hands back `preferences`
 * itself when nothing moved. */
export function carryOverDevicePreferences(
  preferences: NetworkPreferences,
  networks: { id: string; device: string }[]
): NetworkPreferences {
  let result = preferences
  for (const { id, device } of networks) {
    if (id === device || !result[device] || result[id]) continue
    const { [device]: moved, ...others } = result
    result = { ...others, [id]: moved }
  }
  return result
}
