import { api } from './api'
export interface Settings {
  capture: boolean
  sites: string[]
  skipSmall: boolean
  minMegabytes: number
}

const DEFAULTS: Settings = {
  capture: true,
  sites: [],
  skipSmall: false,
  minMegabytes: 1
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULTS, ...(await api.storage.local.get(DEFAULTS)) } as Settings
}

export function saveSettings(patch: Partial<Settings>): Promise<void> {
  return api.storage.local.set(patch)
}

/** The site rule typed or pasted ("https://Drive.Google.com/x", "*.example.com"), or null. */
export function siteOf(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^\*\./, '')
  try {
    const host = new URL(/^[a-z]+:\/\//.test(text) ? text : `https://${text}`).hostname
    return host.includes('.') || host === 'localhost' ? host : null
  } catch {
    return null
  }
}

export function excluded(sites: readonly string[], urls: readonly (string | undefined)[]): boolean {
  return urls.some((url) => {
    if (!url) return false
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return false
    }
    return sites.some((site) => host === site || host.endsWith(`.${site}`))
  })
}
