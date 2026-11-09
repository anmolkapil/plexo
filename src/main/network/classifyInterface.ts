import type { NetworkInterfaceKind } from '../../shared/types'

export function classifyInterface(hardwarePortName: string): NetworkInterfaceKind {
  const name = hardwarePortName.toLowerCase()
  if (/wi-?fi|wireless|wlan|802\.11|airport/.test(name)) return 'wifi'
  if (/rndis|remote ndis|tether|apple mobile device/.test(name)) return 'usb'
  if (name.includes('iphone') || name.includes('ipad') || name.includes('usb')) return 'usb'
  if (name.includes('bridge')) return 'bridge'
  if (name.includes('ethernet') || name.includes('lan')) return 'ethernet'
  return 'other'
}
