import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isLocaleCode, listLocales, normalizeLocaleMap, resolveLanguage } from '../src/shared/i18n'
import { expect, test } from './fixtures'

test.describe('i18n setup @smoke', () => {
  test('resolveLanguage matches exact tags, Chinese script tags, base tags, and fallback', () => {
    expect(resolveLanguage(['zh-Hans-CN'], ['en', 'zh-CN'])).toBe('zh-CN')
    expect(resolveLanguage(['zh-Hans'], ['en', 'zh-CN'])).toBe('zh-CN')
    expect(resolveLanguage(['zh-Hant-TW'], ['en', 'zh-CN', 'zh-TW'])).toBe('zh-TW')
    expect(resolveLanguage(['fr-CA', 'en-US'], ['en', 'fr'])).toBe('fr')
    expect(resolveLanguage(['en-GB'], ['en', 'zh-CN'])).toBe('en')
    expect(resolveLanguage(['ja-JP'], ['en', 'zh-CN'])).toBe('en')
  })

  test('listLocales places English first and reads native names from _meta', () => {
    const resources = normalizeLocaleMap({
      '../locales/zh-CN.json': { _meta: { name: '简体中文' } },
      '../locales/fr.json': {},
      '../locales/en.json': { _meta: { name: 'English' } }
    })
    expect(listLocales(resources)).toEqual([
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'fr' },
      { code: 'zh-CN', name: '简体中文' }
    ])
  })

  test('isLocaleCode accepts valid BCP-47 tags and rejects invalid strings', () => {
    expect(isLocaleCode('en')).toBe(true)
    expect(isLocaleCode('zh-CN')).toBe(true)
    expect(isLocaleCode('pt-BR')).toBe(true)
    expect(isLocaleCode('')).toBe(false)
    expect(isLocaleCode('../secret')).toBe(false)
    expect(isLocaleCode('english language')).toBe(false)
    expect(isLocaleCode(123)).toBe(false)
  })

  test('initializes renderer language, exposes picker in Settings, and persists valid language', async ({
    plexo,
    dirs
  }) => {
    const page = plexo.page
    expect(await page.evaluate(() => window.plexo.initialState.language)).toBe('en')
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')

    await page.getByRole('button', { name: 'Settings' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog.getByRole('heading', { name: 'Language' })).toBeVisible()
    const languageButton = dialog.getByRole('button', { name: 'Language' })
    await expect(languageButton).toHaveText('English')
    await languageButton.click()
    await expect(page.getByRole('menuitemradio', { name: 'English' })).toBeChecked()
    await page.keyboard.press('Escape')
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    await plexo.api.updateSettings({ language: 'zh-CN' })
    const settingsPath = join(dirs.userData, 'app-settings.json')
    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as { language?: string }
    expect(saved.language).toBe('zh-CN')

    // Invalid hand-edited language tags are dropped by sanitizeSettings on restart.
    await plexo.quit()
    await writeFile(settingsPath, JSON.stringify({ language: '../invalid' }))
    await plexo.launch()
    expect(await plexo.page.evaluate(() => window.plexo.initialState.language)).toBe('en')
  })
})
