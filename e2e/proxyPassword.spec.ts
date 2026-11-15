import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { NetworkPreferences, ProxyConfig } from '../src/shared/types'
import type { Locator } from '@playwright/test'
import { BLOCK, expect, test, type PlexoApp } from './fixtures'

// A network's proxy password (main/settings.ts) is sealed with the keychain in app-settings.json,
// as the news server's is, and never sent to the window. Without a keychain (a Linux runner with
// no keyring) a password typed is kept only until Plexo quits.

const USERNAME = 'reader'
const SECRET = 'proxy-secret-4f1c'

/** An HTTP proxy that tunnels only for USERNAME:SECRET, answering 407 to anything else. */
async function authProxy(): Promise<{
  port: number
  accepted: () => number
  refused: () => number
  close: () => Promise<void>
}> {
  let accepted = 0
  let refused = 0
  const expected = `Basic ${Buffer.from(`${USERNAME}:${SECRET}`).toString('base64')}`
  const proxy = createServer()
  proxy.on('connect', (request, client, head) => {
    if (request.headers['proxy-authorization'] !== expected) {
      refused++
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    accepted++
    const [host, port] = request.url!.split(':')
    const target = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) target.write(head)
      target.pipe(client)
      client.pipe(target)
    })
    target.on('error', () => client.destroy())
    client.on('error', () => target.destroy())
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  return {
    port: (proxy.address() as AddressInfo).port,
    accepted: () => accepted,
    refused: () => refused,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.closeAllConnections()
        proxy.close(() => resolve())
      })
  }
}

/** Whether this session can seal a password: the same check main makes. */
function canSeal(plexo: PlexoApp): Promise<boolean> {
  return plexo.electronApp.evaluate(
    ({ safeStorage }) =>
      safeStorage.isEncryptionAvailable() &&
      !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
}

const settingsFile = (plexo: PlexoApp): string => join(plexo.dirs.userData, 'app-settings.json')

/** The network preferences the window was given at launch. */
function windowPreferences(plexo: PlexoApp): Promise<NetworkPreferences> {
  return plexo.page.evaluate(() => window.plexo.initialState.networkPreferences)
}

const proxyAt = (port: number): ProxyConfig => ({
  enabled: true,
  type: 'http',
  host: '127.0.0.1',
  port,
  username: USERNAME
})

test.describe('proxy passwords', () => {
  test('are saved sealed, sign in through the proxy, and are kept on relaunch', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 8 * BLOCK })
    const proxy = await authProxy()
    try {
      const sealing = await canSeal(plexo)
      await plexo.api.updateSettings({
        networkPreferences: { a: { proxy: { ...proxyAt(proxy.port), password: SECRET } } }
      })
      expect(await readFile(settingsFile(plexo), 'utf-8')).not.toContain(SECRET)

      await plexo.start(origin.url(), origin.sha256)
      await plexo.waitForHttpStatus('completed', 30_000)
      expect(proxy.accepted()).toBeGreaterThan(0)
      expect(proxy.refused()).toBe(0)

      // As the window sends it when another field changes: no password, which keeps the saved one.
      await plexo.api.updateSettings({
        networkPreferences: { a: { customName: 'Office', proxy: proxyAt(proxy.port) } }
      })
      expect(await readFile(settingsFile(plexo), 'utf-8')).not.toContain(SECRET)

      await plexo.relaunch()
      const shown = (await windowPreferences(plexo)).a
      expect(shown.customName).toBe('Office')
      expect(shown.proxy?.password).toBeUndefined()
      if (!sealing) {
        // No keychain: it was kept only until Plexo quit.
        expect(shown.proxy?.hasPassword).toBeUndefined()
        return
      }
      expect(shown.proxy?.hasPassword).toBe(true)

      const acceptedBefore = proxy.accepted()
      await plexo.start(origin.url(), origin.sha256, { fileName: 'again.bin' })
      await plexo.waitForHttpStatus('completed', 30_000)
      expect(proxy.accepted()).toBeGreaterThan(acceptedBefore)
      expect(proxy.refused()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('saved in the clear by an older version, one is sealed at launch and still signs in', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 8 * BLOCK })
    const proxy = await authProxy()
    try {
      await plexo.quit()
      await writeFile(
        settingsFile(plexo),
        JSON.stringify({
          networkPreferences: { a: { proxy: { ...proxyAt(proxy.port), password: SECRET } } }
        })
      )
      await plexo.launch()
      const saved = await readFile(settingsFile(plexo), 'utf-8')
      if (await canSeal(plexo)) {
        expect(saved).not.toContain(SECRET)
        expect(JSON.parse(saved).networkPreferences.a.proxy.sealedPassword).toEqual(
          expect.any(String)
        )
      } else {
        // Nothing to seal it with: kept as it was rather than lost.
        expect(JSON.parse(saved).networkPreferences.a.proxy.password).toBe(SECRET)
      }
      const shown = (await windowPreferences(plexo)).a.proxy
      expect(shown?.password).toBeUndefined()
      expect(shown?.hasPassword).toBe(true)

      await plexo.start(origin.url(), origin.sha256)
      await plexo.waitForHttpStatus('completed', 30_000)
      expect(proxy.accepted()).toBeGreaterThan(0)
      expect(proxy.refused()).toBe(0)
    } finally {
      await proxy.close()
    }
  })

  test('a saved password goes only to the proxy and username it was saved for', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 8 * BLOCK })
    const first = await authProxy()
    const other = await authProxy()
    try {
      await plexo.api.updateSettings({
        networkPreferences: { a: { proxy: { ...proxyAt(first.port), password: SECRET } } }
      })
      // Pointed at another proxy with the password left empty, as the form sends it: dropped.
      await plexo.api.updateSettings({ networkPreferences: { a: { proxy: proxyAt(other.port) } } })
      const saved = JSON.parse(await readFile(settingsFile(plexo), 'utf-8'))
      expect(saved.networkPreferences.a.proxy).toMatchObject({ port: other.port })
      expect(saved.networkPreferences.a.proxy.password).toBeUndefined()
      expect(saved.networkPreferences.a.proxy.sealedPassword).toBeUndefined()

      // Turned away for want of a password, it keeps retrying: seen once is enough.
      const id = await plexo.start(origin.url(), origin.sha256)
      await expect.poll(() => other.refused(), { timeout: 15_000 }).toBeGreaterThan(0)
      await plexo.api.pauseDownload(id)
      expect(other.accepted()).toBe(0)
      expect(first.accepted()).toBe(0)

      // The same address written with or without IPv6 brackets is the same proxy.
      if (await canSeal(plexo)) {
        const at = (host: string): ProxyConfig => ({ ...proxyAt(first.port), host })
        await plexo.api.updateSettings({
          networkPreferences: { a: { proxy: { ...at('::1'), password: SECRET } } }
        })
        await plexo.api.updateSettings({ networkPreferences: { a: { proxy: at('[::1]') } } })
        const kept = JSON.parse(await readFile(settingsFile(plexo), 'utf-8'))
        expect(kept.networkPreferences.a.proxy.sealedPassword).toEqual(expect.any(String))
      }
    } finally {
      await first.close()
      await other.close()
    }
  })
})

test.describe('the network’s proxy form', () => {
  test.beforeEach(async ({ plexo }) => {
    test.skip(!(await canSeal(plexo)), 'needs a keychain to keep the password across a launch')
    await plexo.api.updateSettings({
      networkPreferences: { a: { proxy: { ...proxyAt(8080), password: SECRET } } }
    })
    await plexo.relaunch()
    expect(await savedProxy(plexo)).toMatchObject({ sealedPassword: expect.any(String) })
    await plexo.newDownload()
  })

  test('keeps the saved password when another field changes, and Clear removes it', async ({
    plexo
  }) => {
    const { sealedPassword } = await savedProxy(plexo)
    const form = await openProxyForm(plexo)
    const password = form.getByLabel(/^Password/)
    await expect(password).toHaveValue('')
    await expect(password).toHaveAttribute('placeholder', 'Saved')
    await form.getByLabel('Name').fill('Office')
    await form.getByRole('button', { name: 'Done' }).click()
    await expect(form).toBeHidden()
    await expect.poll(() => savedProxy(plexo)).toMatchObject({ sealedPassword })
    const preferences = JSON.parse(await readFile(settingsFile(plexo), 'utf-8')).networkPreferences
    expect(preferences.a.customName).toBe('Office')

    await openProxyForm(plexo)
    await form.getByRole('button', { name: 'Clear saved password' }).click()
    await expect(form.getByLabel(/^Password/)).not.toHaveAttribute('placeholder', 'Saved')
    await form.getByRole('button', { name: 'Done' }).click()
    await expect(form).toBeHidden()
    await expect.poll(() => savedProxy(plexo)).toEqual({ ...proxyAt(8080) })
  })

  test('drops the saved password when the host changes and none is typed', async ({ plexo }) => {
    const form = await openProxyForm(plexo)
    await form.getByLabel('Host / IP').fill('proxy.example.test')
    const password = form.getByLabel(/^Password/)
    await expect(password).not.toHaveAttribute('placeholder', 'Saved')
    await expect(
      form.getByText(/only goes to the proxy and username it was saved for/)
    ).toBeVisible()
    await form.getByRole('button', { name: 'Done' }).click()
    await expect(form).toBeHidden()
    await expect
      .poll(() => savedProxy(plexo))
      .toEqual({ ...proxyAt(8080), host: 'proxy.example.test' })
    expect(await readFile(settingsFile(plexo), 'utf-8')).not.toContain(SECRET)
  })
})

/** Network a's proxy as app-settings.json has it. */
async function savedProxy(plexo: PlexoApp): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(settingsFile(plexo), 'utf-8')).networkPreferences.a.proxy
}

/** Opens network a's edit form from New download. */
async function openProxyForm(plexo: PlexoApp): Promise<Locator> {
  await plexo.page
    .getByRole('button', { name: /^Configure proxy/ })
    .first()
    .click()
  const form = plexo.page.getByRole('dialog', { name: /^Edit / })
  await expect(form).toBeVisible()
  return form
}
