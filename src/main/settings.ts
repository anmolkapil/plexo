import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { app, nativeTheme } from 'electron'
import { PRESET_STREAMS } from '../shared/plan'
import type {
  AppSettings,
  NetworkPreference,
  NetworkPreferences,
  ProxyConfig,
  ProxyType,
  ThemeSource
} from '../shared/types'
import { readJson, updateJson } from './jsonFile'

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const VALID_PROXY_TYPES: readonly ProxyType[] = ['http', 'https', 'socks4', 'socks5']

function sanitizeProxyConfig(value: unknown): ProxyConfig | undefined {
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

  return {
    enabled,
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {})
  }
}

/** Keeps only valid customName, colorId, and proxy fields, entry by entry, rather than discarding every
 * network over one bad entry. An entry left with neither field is dropped, so resetting a
 * network removes it from the file. */
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
    if (preference.customName || preference.colorId || preference.proxy) result[id] = preference
  }
  return result
}

/** Trusts nothing past "this is valid JSON" — the file may be hand-edited or from an older
 * version, and a patch comes from the renderer. Every field is checked on its own, so one bad
 * value only loses that value. An `undefined` field in a patch clears it. */
function sanitizeSettings(parsed: unknown): AppSettings {
  if (!isRecord(parsed)) return {}

  const { themeSource, dismissedUpdateVersion, streamsPerNetwork, destinationDir } = parsed
  const settings: AppSettings = {}
  // 'system' was once an option — dropping it falls back to the OS appearance (loadThemeSource).
  if (themeSource === 'light' || themeSource === 'dark') settings.themeSource = themeSource
  if (typeof dismissedUpdateVersion === 'string') {
    settings.dismissedUpdateVersion = dismissedUpdateVersion
  }
  if ((PRESET_STREAMS as readonly unknown[]).includes(streamsPerNetwork)) {
    settings.streamsPerNetwork = streamsPerNetwork as number
  }
  if (typeof destinationDir === 'string' && isAbsolute(destinationDir)) {
    settings.destinationDir = destinationDir
  }
  if (parsed.networkPreferences !== undefined) {
    settings.networkPreferences = sanitizeNetworkPreferences(parsed.networkPreferences)
  }
  return settings
}

export async function loadSettings(): Promise<AppSettings> {
  // Reading can fall back to defaults; only a save must not act on a failed read.
  try {
    return sanitizeSettings(await readJson(settingsPath()))
  } catch {
    return {}
  }
}

/** Merges `patch` over what's saved. */
export function saveSettings(patch: unknown): Promise<void> {
  return updateJson(settingsPath(), (current) =>
    sanitizeSettings({ ...sanitizeSettings(current), ...(isRecord(patch) ? patch : {}) })
  )
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
