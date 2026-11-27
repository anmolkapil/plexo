import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  FALLBACK_LANGUAGE,
  i18nextResources,
  listLocales,
  normalizeLocaleMap,
  resolveLanguage,
  type LocaleResource
} from '@shared/i18n'

const localeModules = import.meta.glob<LocaleResource>('../../locales/*.json', {
  eager: true,
  import: 'default'
})

const resources = normalizeLocaleMap(localeModules)
const availableCodes = Object.keys(resources)

export const AVAILABLE_LOCALES = listLocales(resources)

export async function initRendererI18n(language: string): Promise<void> {
  const resolved = resolveLanguage([language], availableCodes)
  document.documentElement.lang = resolved
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      lng: resolved,
      fallbackLng: FALLBACK_LANGUAGE,
      resources: i18nextResources(resources),
      interpolation: { escapeValue: false }
    })
  } else if (i18next.language !== resolved) {
    await i18next.changeLanguage(resolved)
  }
}

export async function changeRendererLanguage(language: string): Promise<void> {
  const resolved = resolveLanguage([language], availableCodes)
  document.documentElement.lang = resolved
  await i18next.changeLanguage(resolved)
}
