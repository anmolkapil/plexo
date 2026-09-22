import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import type { ThemeSource } from '../shared/types'

function settingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json')
}

interface AppSettings {
  themeSource?: ThemeSource
  dismissedUpdateVersion?: string
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8')
    return JSON.parse(raw) as AppSettings
  } catch {
    // No file yet (first run) or it's unreadable/corrupt — either way, no saved settings.
    return {}
  }
}

export async function loadThemeSource(): Promise<ThemeSource> {
  const settings = await loadSettings()
  if (settings.themeSource === 'light' || settings.themeSource === 'dark') {
    return settings.themeSource
  }
  // First run, or a pre-existing settings file from when 'system' was an option — fall back to
  // whatever the OS appearance is right now rather than defaulting to a fixed theme.
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

export async function saveThemeSource(themeSource: ThemeSource): Promise<void> {
  const settings = await loadSettings()
  await writeFile(settingsPath(), JSON.stringify({ ...settings, themeSource }, null, 2), 'utf-8')
}

export async function loadDismissedUpdateVersion(): Promise<string | undefined> {
  const settings = await loadSettings()
  return settings.dismissedUpdateVersion
}

export async function saveDismissedUpdateVersion(version: string): Promise<void> {
  const settings = await loadSettings()
  await writeFile(
    settingsPath(),
    JSON.stringify({ ...settings, dismissedUpdateVersion: version }, null, 2),
    'utf-8'
  )
}
