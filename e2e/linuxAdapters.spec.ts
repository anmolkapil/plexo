import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { getLinuxAdapters } from '../src/main/network/linuxAdapters'
import { carryOverDevicePreferences } from '../src/shared/networkPreferences'

// A phone tethered over USB gets a new device name each time, so it's known by its USB serial.

/** Lays out /sys as Linux does for one USB network adapter: the entry in class/net links to the
 * interface under its USB device, and `device` links to the network function, whose parent folder
 * is the USB device holding `serial`. */
async function addUsbAdapter(
  root: string,
  name: string,
  port: string,
  serial?: string
): Promise<void> {
  const usbDevice = join(root, 'devices/pci0000:00/usb1', port)
  const interfaceDir = join(usbDevice, `${port}:1.0/net`, name)
  await mkdir(interfaceDir, { recursive: true })
  if (serial) await writeFile(join(usbDevice, 'serial'), `${serial}\n`)
  await symlink(join(usbDevice, `${port}:1.0`), join(interfaceDir, 'device'))
  const entry = join(root, 'class/net', name)
  await mkdir(dirname(entry), { recursive: true })
  await symlink(interfaceDir, entry)
}

test.describe('USB network adapters on Linux @smoke', () => {
  let root: string
  const adapters = (): ReturnType<typeof getLinuxAdapters> =>
    getLinuxAdapters(join(root, 'class/net'))

  test.skip(process.platform !== 'linux', 'reads Linux sysfs')
  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'plexo-sysfs-'))
  })
  test.afterEach(() => rm(root, { recursive: true, force: true }))

  test('an adapter takes the serial of the USB device behind it', async () => {
    await addUsbAdapter(root, 'enx8e1dfa42a7fe', '1-2', 'RZCX12KDXRY')
    const adapter = (await adapters()).get('enx8e1dfa42a7fe')
    expect(adapter?.kind).toBe('usb')
    expect(adapter?.usbSerial).toBe('RZCX12KDXRY')
  })

  test('a USB device without a serial has none to go by', async () => {
    await addUsbAdapter(root, 'enx8e1dfa42a7fe', '1-2')
    const adapter = (await adapters()).get('enx8e1dfa42a7fe')
    expect(adapter?.kind).toBe('usb')
    expect(adapter?.usbSerial).toBeUndefined()
  })

  test('a serial two adapters share names neither', async () => {
    await addUsbAdapter(root, 'enxaaaaaaaaaaaa', '1-2', '0123456789ABCDEF')
    await addUsbAdapter(root, 'enxbbbbbbbbbbbb', '1-3', '0123456789ABCDEF')
    await addUsbAdapter(root, 'enxcccccccccccc', '1-4', 'RZCX12KDXRY')
    const found = await adapters()
    expect(found.get('enxaaaaaaaaaaaa')?.usbSerial).toBeUndefined()
    expect(found.get('enxbbbbbbbbbbbb')?.usbSerial).toBeUndefined()
    expect(found.get('enxcccccccccccc')?.usbSerial).toBe('RZCX12KDXRY')
  })
})

test.describe('settings saved under a device name @smoke', () => {
  const dongle = { id: 'usb:ABC', device: 'enxdongle' }

  test('move to the id the network now has', () => {
    const saved = { enxdongle: { customName: 'Office' }, wlp3s0: { customName: 'Home' } }
    expect(carryOverDevicePreferences(saved, [dongle])).toEqual({
      'usb:ABC': { customName: 'Office' },
      wlp3s0: { customName: 'Home' }
    })
  })

  test('do not replace what the new id already has', () => {
    const saved = { enxdongle: { customName: 'Old' }, 'usb:ABC': { customName: 'New' } }
    expect(carryOverDevicePreferences(saved, [dongle])).toBe(saved)
  })

  test('stay where they are when the id is the device name', () => {
    const saved = { wlp3s0: { customName: 'Home' } }
    expect(carryOverDevicePreferences(saved, [{ id: 'wlp3s0', device: 'wlp3s0' }])).toBe(saved)
  })
})
