import i18next, { type TOptions } from 'i18next'
import {
  FALLBACK_LANGUAGE,
  i18nextResources,
  normalizeLocaleMap,
  resolveLanguage,
  type LocaleResource
} from '../shared/i18n'

const localeModules = import.meta.glob<LocaleResource>('../locales/*.json', {
  eager: true,
  import: 'default'
})

const resources = normalizeLocaleMap(localeModules)
const availableCodes = Object.keys(resources)

const mainI18n = i18next.createInstance()

export function resolveMainLanguage(preferred: readonly string[]): string {
  return resolveLanguage(preferred, availableCodes)
}

export async function initMainI18n(language: string): Promise<string> {
  const resolved = resolveMainLanguage([language])
  if (!mainI18n.isInitialized) {
    await mainI18n.init({
      lng: resolved,
      fallbackLng: FALLBACK_LANGUAGE,
      resources: i18nextResources(resources),
      interpolation: { escapeValue: false }
    })
  } else if (mainI18n.language !== resolved) {
    await mainI18n.changeLanguage(resolved)
  }
  return resolved
}

export async function changeMainLanguage(language: string): Promise<string> {
  return initMainI18n(language)
}

export function tMain(key: string, options?: TOptions): string {
  if (!mainI18n.isInitialized) return key
  return options ? mainI18n.t(key, options) : mainI18n.t(key)
}
