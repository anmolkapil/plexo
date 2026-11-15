import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, nativeTheme, safeStorage } from 'electron'
import {
  DOWNLOADS_AT_ONCE,
  type AppSettings,
  type NetworkPreference,
  type NetworkPreferences,
  type ProxyConfig,
  type ProxyType,
  type ThemeSource
} from '../shared/types'
import { readJson, updateJson } from './jsonFile'
import { DEFAULT_DOWNLOAD_SCHEDULE, validSchedule } from '../shared/downloadSchedule'

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_PROXY_TYPES: readonly ProxyType[] = ['http', 'https', 'socks4', 'socks5']

/** A proxy as app-settings.json keeps it: its password sealed with the computer's keychain, as
 * the news server's is (see nzb/usenetServer.ts). A file saved before passwords were sealed has
 * `password` in the clear instead; sealProxyPasswords seals it at the next launch, and any save
 * does too. */
type SavedProxy = ProxyConfig & { sealedPassword?: string }

/** Proxy passwords by network id, when this computer has no keychain to seal them with: kept
 * until Plexo quits rather than written in the clear. */
const inMemory = new Map<string, string>()

/** As for the news server's password: never written in the clear, and on Linux without a
 * keyring (where safeStorage falls back to a fixed key), not written at all. */
export function canSealPasswords(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
}

function seal(password: string): string | undefined {
  if (!canSealPasswords()) return undefined
  try {
    return safeStorage.encryptString(password).toString('base64')
  } catch {
    // The keychain refused: kept for this session instead.
    return undefined
  }
}

function unseal(sealed: string): string | undefined {
  if (!canSealPasswords()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    // Sealed by another keychain (a restored profile, say): it has to be entered again. It
    // stays saved meanwhile, for a session that can still open it.
    return undefined
  }
}

function sanitizeProxyConfig(value: unknown): SavedProxy | undefined {
  if (!isRecord(value)) return undefined
  const enabled = typeof value.enabled === 'boolean' ? value.enabled : false
  const type =
    typeof value.type === 'string' && (VALID_PROXY_TYPES as readonly string[]).includes(value.type)
      ? (value.type as ProxyType)
      : 'http'
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  const port =
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
      ? value.port
      : 8080
  const username =
    typeof value.username === 'string' && value.username.length > 0 ? value.username : undefined
  const password =
    typeof value.password === 'string' && value.password.length > 0 ? value.password : undefined
  const sealedPassword =
    typeof value.sealedPassword === 'string' && value.sealedPassword.length > 0
      ? value.sealedPassword
      : undefined

  return {
    enabled,
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(sealedPassword ? { sealedPassword } : {})
  }
}

/** Each network's preferences with `change` applied to its proxy, the others as they are. */
function mapProxies(
  preferences: NetworkPreferences,
  change: (proxy: SavedProxy, id: string) => ProxyConfig
): NetworkPreferences {
  return Object.fromEntries(
    Object.entries(preferences).map(([id, preference]) => [
      id,
      preference.proxy ? { ...preference, proxy: change(preference.proxy, id) } : preference
    ])
  )
}

/** As the main process uses it: its password unsealed, for the proxy connection. */
function unsealed({ sealedPassword, password, ...proxy }: SavedProxy, id: string): ProxyConfig {
  const known = inMemory.get(id) ?? (sealedPassword ? unseal(sealedPassword) : password)
  return {
    ...proxy,
    ...(known ? { password: known } : {}),
    // One this session can't unseal is still saved: left blank in the window, it stays.
    ...(known || sealedPassword ? { hasPassword: true } : {})
  }
}

/** What the window may see: whether there's a password, never the password itself. */
export function networkPreferencesForWindow(preferences: NetworkPreferences): NetworkPreferences {
  return mapProxies(preferences, (proxy) => ({ ...proxy, password: undefined }))
}

/** A password from before they were sealed, sealed now. Left as it was when this computer has no
 * keychain: written in the clear by an older version, it would otherwise be lost. */
function sealedFromClear({ password, ...proxy }: SavedProxy): SavedProxy {
  const sealedPassword = password ? seal(password) : undefined
  return sealedPassword ? { ...proxy, sealedPassword } : { ...proxy, ...(password && { password }) }
}

/** The settings as the file keeps them: no proxy password in the clear that can be sealed. */
function passwordsSealed(settings: AppSettings): AppSettings {
  return settings.networkPreferences
    ? { ...settings, networkPreferences: mapProxies(settings.networkPreferences, sealedFromClear) }
    : settings
}

/** The networks as the window sends them, each proxy's password as the file will keep it: a new
 * one sealed (or, with no keychain, kept for this session), '' clearing it, and none keeping the
 * one already saved — the window never has it to send back, whichever field it changes. */
function withSavedPasswords(sent: unknown, saved: NetworkPreferences): unknown {
  if (!isRecord(sent)) return sent
  // A network left out is reset: its password goes with it.
  for (const id of inMemory.keys()) if (!(id in sent)) inMemory.delete(id)
  const result: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(sent)) {
    if (!isRecord(value) || !isRecord(value.proxy)) {
      inMemory.delete(id)
      result[id] = value
      continue
    }
    const { password } = value.proxy
    // Only a password: nothing sealed comes from the window.
    const fields = { ...value.proxy, password: undefined, sealedPassword: undefined }
    let proxy: Record<string, unknown> = fields
    if (password === undefined) {
      const kept = saved[id]?.proxy as SavedProxy | undefined
      proxy = {
        ...fields,
        ...(kept?.sealedPassword && { sealedPassword: kept.sealedPassword }),
        ...(kept?.password && { password: kept.password })
      }
    } else if (typeof password === 'string' && password !== '') {
      const sealedPassword = seal(password)
      if (sealedPassword) {
        inMemory.delete(id)
        proxy = { ...fields, sealedPassword }
      } else {
        inMemory.set(id, password)
      }
    } else {
      inMemory.delete(id)
    }
    result[id] = { ...value, proxy }
  }
  return result
}

/** A rate or an amount of bytes: a positive whole number, or nothing. */
function byteCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

/** Keeps only fields of the right type (what every reader downstream assumes, e.g.
 * NetworkEditPopover's `customName?.trim()`), entry by entry, rather than discarding every
 * network over one bad entry. An entry left with no field is dropped, so resetting a network
 * removes it from the file. */
function sanitizeNetworkPreferences(parsed: unknown): NetworkPreferences {
  if (!isRecord(parsed)) return {}

  const result: NetworkPreferences = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue
    const preference: NetworkPreference = {}
    if (typeof value.customName === 'string') preference.customName = value.customName
    if (typeof value.colorId === 'string') preference.colorId = value.colorId
    const proxy = sanitizeProxyConfig(value.proxy)
    if (proxy) preference.proxy = proxy
    if (value.off === true) preference.off = true
    preference.speedLimit = byteCount(value.speedLimit)
    preference.dataLimit = byteCount(value.dataLimit)
    if (
      value.dataLimitPeriod === 'day' ||
      value.dataLimitPeriod === 'week' ||
      value.dataLimitPeriod === 'month'
    ) {
      preference.dataLimitPeriod = value.dataLimitPeriod
    }
    for (const key of Object.keys(preference) as (keyof NetworkPreference)[]) {
      if (preference[key] === undefined) delete preference[key]
    }
    if (Object.keys(preference).length > 0) result[id] = preference
  }
  return result
}

/** Trusts nothing past "this is valid JSON" — the file may be hand-edited or from an older
 * version, and a patch comes from the renderer. Every field is checked on its own, so one bad
 * value only loses that value. An `undefined` field in a patch clears it. */
function sanitizeSettings(parsed: unknown): AppSettings {
  if (!isRecord(parsed)) return {}

  const { themeSource, destinationDir, downloadsAtOnce } = parsed
  const settings: AppSettings = {}
  if (parsed.downloadSchedule !== undefined) {
    settings.downloadSchedule = validSchedule(parsed.downloadSchedule)
      ? parsed.downloadSchedule
      : { ...DEFAULT_DOWNLOAD_SCHEDULE, enabled: true, days: [] }
  }
  // 'system' was once an option — dropping it falls back to the OS appearance (loadThemeSource).
  if (themeSource === 'light' || themeSource === 'dark') settings.themeSource = themeSource
  if (parsed.autoUpdate === false) settings.autoUpdate = false
  if (typeof destinationDir === 'string' && isAbsolute(destinationDir)) {
    settings.destinationDir = destinationDir
  }
  if (
    typeof parsed.defaultDestinationDir === 'string' &&
    isAbsolute(parsed.defaultDestinationDir)
  ) {
    settings.defaultDestinationDir = parsed.defaultDestinationDir
  }
  // Clamped rather than dropped: a count saved under an older, higher limit keeps the most allowed.
  if (Number.isInteger(downloadsAtOnce) && (downloadsAtOnce as number) >= DOWNLOADS_AT_ONCE.min) {
    settings.downloadsAtOnce = Math.min(downloadsAtOnce as number, DOWNLOADS_AT_ONCE.max)
  }
  if (parsed.networkPreferences !== undefined) {
    settings.networkPreferences = sanitizeNetworkPreferences(parsed.networkPreferences)
  }
  const speedLimit = byteCount(parsed.speedLimit)
  if (speedLimit !== undefined) settings.speedLimit = speedLimit
  const slowModeSpeed = byteCount(parsed.slowModeSpeed)
  if (slowModeSpeed !== undefined) settings.slowModeSpeed = slowModeSpeed
  if (parsed.slowMode === true) settings.slowMode = true
  if (parsed.speedUnit === 'bytes' || parsed.speedUnit === 'bits') {
    settings.speedUnit = parsed.speedUnit
  }
  if (parsed.browserExtensionUsed === true) settings.browserExtensionUsed = true
  return settings
}

/** The settings, proxy passwords unsealed: for the main process only (see
 * networkPreferencesForWindow). */
export async function loadSettings(): Promise<AppSettings> {
  // Reading can fall back to defaults; only a save must not act on a failed read.
  try {
    const settings = sanitizeSettings(await readJson(settingsPath()))
    return settings.networkPreferences
      ? { ...settings, networkPreferences: mapProxies(settings.networkPreferences, unsealed) }
      : settings
  } catch {
    return {}
  }
}

/** Seals the proxy passwords a file from an older version has in the clear. Writes nothing when
 * there are none, or no keychain to seal them with. */
export async function sealProxyPasswords(): Promise<void> {
  if (!canSealPasswords()) return
  const { networkPreferences } = sanitizeSettings(await readJson(settingsPath()))
  const inClear = Object.values(networkPreferences ?? {}).some((preference) =>
    Boolean(preference.proxy?.password)
  )
  if (!inClear) return
  await updateJson(settingsPath(), (current) => passwordsSealed(sanitizeSettings(current)))
}

/** Merges `patch` over what's saved. */
export function saveSettings(patch: unknown): Promise<void> {
  if (
    isRecord(patch) &&
    patch.downloadSchedule !== undefined &&
    !validSchedule(patch.downloadSchedule)
  ) {
    return Promise.reject(new Error('Choose different start and stop times and at least one day.'))
  }
  return updateJson(settingsPath(), (current) => {
    const saved = sanitizeSettings(current)
    const merged = { ...saved, ...(isRecord(patch) ? patch : {}) }
    if (isRecord(patch) && 'defaultDestinationDir' in patch && !patch.defaultDestinationDir) {
      delete (merged as Record<string, unknown>).defaultDestinationDir
    }
    if (isRecord(patch) && patch.networkPreferences !== undefined) {
      merged.networkPreferences = withSavedPasswords(
        patch.networkPreferences,
        saved.networkPreferences ?? {}
      ) as NetworkPreferences
    }
    return passwordsSealed(sanitizeSettings(merged))
  })
}

export async function loadThemeSource(): Promise<ThemeSource> {
  const { themeSource } = await loadSettings()
  // First run — follow whatever the OS appearance is right now rather than a fixed theme.
  return themeSource ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
}

/** Network names/colors lived in their own network-preferences.json up to 1.0.0-rc.8. Folds
 * that file into app-settings.json once, then deletes it (a corrupt one is just deleted). */
export async function migrateLegacyNetworkPreferences(): Promise<void> {
  const legacyPath = join(app.getPath('userData'), 'network-preferences.json')
  const legacy = await readJson(legacyPath)
  if (legacy !== undefined) {
    await updateJson(settingsPath(), (current) => {
      const settings = sanitizeSettings(current)
      return settings.networkPreferences
        ? settings
        : { ...settings, networkPreferences: sanitizeNetworkPreferences(legacy) }
    })
  }
  await rm(legacyPath, { force: true })
}
