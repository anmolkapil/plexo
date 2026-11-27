export const FALLBACK_LANGUAGE = 'en'

export type LocaleResource = Record<string, unknown>

export interface LocaleSummary {
  code: string
  name: string
}

const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i

export function isLocaleCode(value: unknown): value is string {
  return typeof value === 'string' && LOCALE_CODE_RE.test(value.trim())
}

/** Extracts `<code >.json` entries from a Vite `import.meta.glob` map. */
export function normalizeLocaleMap(
  modules: Record<string, LocaleResource>
): Record<string, LocaleResource> {
  const resources: Record<string, LocaleResource> = {}
  for (const [path, data] of Object.entries(modules)) {
    const match = /\/([^/]+)\.json$/i.exec(path)
    if (!match) continue
    resources[match[1]] = data
  }
  return resources
}

/** Lists available locales using each file's `_meta.name`, with English first. */
export function listLocales(resources: Record<string, LocaleResource>): LocaleSummary[] {
  return Object.entries(resources)
    .map(([code, data]) => {
      const meta = data._meta
      const name =
        typeof meta === 'object' &&
        meta !== null &&
        typeof (meta as Record<string, unknown>).name === 'string'
          ? String((meta as Record<string, unknown>).name)
          : code
      return { code, name }
    })
    .sort((a, b) => {
      if (a.code === FALLBACK_LANGUAGE) return -1
      if (b.code === FALLBACK_LANGUAGE) return 1
      return a.code.localeCompare(b.code)
    })
}

export function i18nextResources(
  resources: Record<string, LocaleResource>
): Record<string, { translation: LocaleResource }> {
  const out: Record<string, { translation: LocaleResource }> = {}
  for (const [code, data] of Object.entries(resources)) {
    out[code] = { translation: data }
  }
  return out
}

function findIgnoreCase(available: readonly string[], target: string): string | undefined {
  const lower = target.toLowerCase()
  return available.find((code) => code.toLowerCase() === lower)
}

/** Picks the best available locale for an ordered list of preferred BCP-47 tags. */
export function resolveLanguage(
  preferred: readonly string[],
  available: readonly string[]
): string {
  for (const raw of preferred) {
    const candidate = raw.trim()
    if (!candidate) continue

    const exact = findIgnoreCase(available, candidate)
    if (exact) return exact

    const lower = candidate.toLowerCase()
    if (lower.startsWith('zh-hans') || lower === 'zh-cn' || lower === 'zh-sg') {
      const simplified = findIgnoreCase(available, 'zh-CN')
      if (simplified) return simplified
    }
    if (
      lower.startsWith('zh-hant') ||
      lower === 'zh-tw' ||
      lower === 'zh-hk' ||
      lower === 'zh-mo'
    ) {
      const traditional = findIgnoreCase(available, 'zh-TW')
      if (traditional) return traditional
    }

    const base = lower.split('-')[0]
    const byBase = findIgnoreCase(available, base)
    if (byBase) return byBase
  }

  return findIgnoreCase(available, FALLBACK_LANGUAGE) ?? available[0] ?? FALLBACK_LANGUAGE
}
