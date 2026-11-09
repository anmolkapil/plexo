import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { NetworkInterfaceKind } from '../../shared/types'
import { classifyInterface } from './classifyInterface'

const execFileAsync = promisify(execFile)

export interface LinuxAdapter {
  displayName: string
  kind: NetworkInterfaceKind
  /** The USB serial of the device behind a USB network adapter, such as a tethered phone. */
  usbSerial?: string
}

/** A phone shared over USB gets a random MAC each time it's plugged in, and so a new enx… name
 * that matches nothing saved for it. The serial its USB device reports doesn't change: the network
 * function is …/usb1/1-2/1-2:1.0, and its parent, 1-2, is the phone. */
async function readUsbSerial(sysPath: string): Promise<string | undefined> {
  try {
    const usbDevice = await realpath(`${sysPath}/device/..`)
    if (!usbDevice.includes('/usb')) return undefined
    return (await readFile(`${usbDevice}/serial`, 'utf8')).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Queries Linux sysfs and udev to detect hardware interfaces (PCI, USB, Wi-Fi, Ethernet)
 * and filter out virtual host/container bridges (e.g. docker0, br-*, veth*).
 */
export async function getLinuxAdapters(
  sysRoot = '/sys/class/net'
): Promise<Map<string, LinuxAdapter>> {
  const adapters = new Map<string, LinuxAdapter>()
  if (process.platform !== 'linux') return adapters

  let devices: string[]
  try {
    devices = await readdir(sysRoot)
  } catch {
    return adapters
  }

  await Promise.all(
    devices.map(async (device) => {
      if (device === 'lo') return
      // Filter out internal container, hypervisor, and dummy bridges/interfaces
      if (/^(docker|br-|veth|virbr|vboxnet|vmnet|cni|flannel|cbr|dummy)/i.test(device)) return

      const sysPath = `${sysRoot}/${device}`
      let isVirtual = false
      try {
        const link = await readlink(sysPath)
        isVirtual = link.includes('/devices/virtual/')
      } catch {
        /* ignore */
      }

      // Pure virtual devices with no hardware backing and no wireless/phy capabilities
      if (
        isVirtual &&
        !existsSync(`${sysPath}/device`) &&
        !existsSync(`${sysPath}/wireless`) &&
        !existsSync(`${sysPath}/phy80211`)
      ) {
        return
      }

      let isWireless =
        existsSync(`${sysPath}/wireless`) ||
        existsSync(`${sysPath}/phy80211`) ||
        /^wl/i.test(device)

      let isUsb = /^usb|^rndis/i.test(device)
      try {
        const link = await readlink(sysPath)
        if (link.includes('/usb')) isUsb = true
      } catch {
        /* ignore */
      }

      let udevModel = ''
      try {
        const { stdout } = await execFileAsync('udevadm', ['info', '-q', 'property', sysPath], {
          timeout: 1000
        })
        for (const line of stdout.split('\n')) {
          if (line.startsWith('ID_BUS=usb')) isUsb = true
          if (line.startsWith('DEVTYPE=wlan')) isWireless = true
          if (line.startsWith('ID_MODEL_FROM_DATABASE=')) {
            udevModel = line.slice('ID_MODEL_FROM_DATABASE='.length).trim()
          }
        }
      } catch {
        /* ignore */
      }

      let kind: NetworkInterfaceKind = 'other'
      if (isWireless) kind = 'wifi'
      else if (isUsb) kind = 'usb'
      else if (/^(eth|en)/i.test(device)) kind = 'ethernet'
      else kind = classifyInterface(device)

      const displayName =
        udevModel ||
        (kind === 'wifi'
          ? 'Wi-Fi'
          : kind === 'ethernet'
            ? 'Ethernet'
            : kind === 'usb'
              ? 'USB Network'
              : device)

      const usbSerial = kind === 'usb' ? await readUsbSerial(sysPath) : undefined
      adapters.set(device, { displayName, kind, usbSerial })
    })
  )

  // Ids must be unique: a serial two devices share (cheap phones that all report
  // 0123456789ABCDEF, or one phone with two network functions) names neither of them.
  const serials = [...adapters.values()].flatMap((adapter) =>
    adapter.usbSerial ? [adapter.usbSerial] : []
  )
  const shared = new Set(serials.filter((serial, i) => serials.indexOf(serial) !== i))
  for (const adapter of adapters.values()) {
    if (adapter.usbSerial && shared.has(adapter.usbSerial)) delete adapter.usbSerial
  }

  return adapters
}
