import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test'

// M. The download page: what each file is called, which one a visitor is offered, and that the
// page says so. The logic lives in docs/downloads.js; the page is checked by loading the real
// docs/index.html in a hidden window as a visitor with a given browser would see it.

interface Asset {
  os: 'mac' | 'win' | 'linux'
  arch: 'arm64' | 'x64' | 'any'
  kind: string
  title: string
  detail: string
  file: string
  url: string
  recommended: boolean
}
interface Model {
  groups: { os: string; label: string; rows: Asset[]; notes: string[] }[]
  primary: { asset: Asset; title: string; meta: string } | null
  alternates: { text: string; asset: Asset }[]
  hint: string | null
  desktop: boolean
  empty: boolean
}
interface Env {
  os: string
  arch: 'arm64' | 'x64' | null
}
const D = createRequire(__filename)('../docs/downloads.js').PlexoDownloads as {
  describe: (name: string) => Omit<Asset, 'file' | 'url' | 'recommended'> | null
  detectEnvironment: (
    nav: { userAgent: string; platform: string; maxTouchPoints?: number },
    hint?: { architecture: string } | null
  ) => Env
  build: (release: unknown, env: Env) => Model
  markdown: (files: { name: string; size: number; url: string }[], site: string) => string
}

// What a release actually contains (rc.7's file names), plus what electron-builder leaves lying
// around in dist/ that must never be offered.
const SHIPPED = [
  'plexo-1.0.0-rc.7-arm64.AppImage',
  'plexo-1.0.0-rc.7-arm64.dmg',
  'plexo-1.0.0-rc.7-setup.exe',
  'plexo-1.0.0-rc.7-x64.dmg',
  'plexo-1.0.0-rc.7-x86_64.AppImage',
  'plexo_1.0.0-rc.7_amd64.deb',
  'plexo_1.0.0-rc.7_arm64.deb'
]
const NOISE = [
  'latest.yml',
  'latest-mac.yml',
  'plexo-1.0.0-rc.7-arm64.dmg.blockmap',
  'plexo-1.0.0-rc.7-setup.exe.blockmap',
  'plexo_1.0.0-rc.7_amd64.snap',
  'Plexo-1.0.0-rc.4-arm64-mac.zip'
]
const BASE = 'https://github.com/anmolkapil/plexo/releases/download/v1.0.0-rc.7/'
const release = (names: string[] = [...SHIPPED, ...NOISE]): unknown => ({
  tag_name: 'v1.0.0-rc.7',
  prerelease: true,
  published_at: '2026-09-19T08:34:03Z',
  assets: names.map((name, i) => ({
    name,
    size: (90 + i) * 1048576,
    browser_download_url: BASE + name
  }))
})

// Browsers as they really introduce themselves. Note that Chrome on an Apple silicon Mac still
// says "Intel" in its user agent — only its client hints tell the truth.
const BROWSERS = {
  chromeMac: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'MacIntel'
  },
  safariMac: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel'
  },
  firefoxLinux: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    platform: 'Linux x86_64'
  },
  chromeLinuxArm: {
    userAgent:
      'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Linux aarch64'
  },
  chromeWindows: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Win32'
  },
  iphone: {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone'
  },
  ipadDesktopMode: {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5
  },
  android: {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv81'
  },
  chromeOs: {
    userAgent:
      'Mozilla/5.0 (X11; CrOS x86_64 15662.76.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Linux x86_64'
  }
} as const

test.describe('what each file is', () => {
  const expected: Record<string, [string, string, string]> = {
    'plexo-1.0.0-rc.7-arm64.dmg': ['mac', 'arm64', 'Apple silicon'],
    'plexo-1.0.0-rc.7-x64.dmg': ['mac', 'x64', 'Intel'],
    'plexo-1.0.0-rc.7-setup.exe': ['win', 'any', 'Windows 10 and 11'],
    'plexo-1.0.0-rc.7-x86_64.AppImage': ['linux', 'x64', 'AppImage · x86_64'],
    'plexo-1.0.0-rc.7-arm64.AppImage': ['linux', 'arm64', 'AppImage · ARM64'],
    'plexo_1.0.0-rc.7_amd64.deb': ['linux', 'x64', 'Debian / Ubuntu · x86_64'],
    'plexo_1.0.0-rc.7_arm64.deb': ['linux', 'arm64', 'Debian / Ubuntu · ARM64']
  }

  for (const [file, [os, arch, title]] of Object.entries(expected)) {
    test(`${file} → ${title}`, () => {
      expect(D.describe(file)).toMatchObject({ os, arch, title })
    })
  }

  test('update metadata, blockmaps, snaps and zips are never offered', () => {
    for (const name of NOISE) expect(D.describe(name), name).toBeNull()
  })

  test('a Windows installer with an architecture in its name is described as that one', () => {
    expect(D.describe('plexo-2.0.0-x64-setup.exe')).toMatchObject({
      arch: 'x64',
      title: 'Windows · x64'
    })
    expect(D.describe('plexo-2.0.0-arm64-setup.exe')).toMatchObject({ arch: 'arm64' })
  })
})

test.describe('which browser is on which system', () => {
  const nav = (b: { userAgent: string; platform: string; maxTouchPoints?: number }): typeof b => b

  test('a Mac stays undecided unless the browser says what chip it has', () => {
    expect(D.detectEnvironment(nav(BROWSERS.safariMac))).toEqual({ os: 'mac', arch: null })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), null)).toEqual({ os: 'mac', arch: null })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), { architecture: 'arm' })).toEqual({
      os: 'mac',
      arch: 'arm64'
    })
    expect(D.detectEnvironment(nav(BROWSERS.chromeMac), { architecture: 'x86' })).toEqual({
      os: 'mac',
      arch: 'x64'
    })
  })

  test('Linux says its architecture in the platform string', () => {
    expect(D.detectEnvironment(nav(BROWSERS.firefoxLinux))).toEqual({ os: 'linux', arch: 'x64' })
    expect(D.detectEnvironment(nav(BROWSERS.chromeLinuxArm))).toEqual({
      os: 'linux',
      arch: 'arm64'
    })
  })

  test('Windows, phones, tablets and Chromebooks', () => {
    expect(D.detectEnvironment(nav(BROWSERS.chromeWindows)).os).toBe('win')
    expect(D.detectEnvironment(nav(BROWSERS.iphone))).toEqual({ os: 'mobile', arch: 'arm64' })
    expect(D.detectEnvironment(nav(BROWSERS.android))).toEqual({ os: 'mobile', arch: 'arm64' }) // not Linux
    expect(D.detectEnvironment(nav(BROWSERS.ipadDesktopMode))).toEqual({
      os: 'mobile',
      arch: 'arm64'
    }) // not a Mac
    expect(D.detectEnvironment(nav(BROWSERS.chromeOs)).os).toBe('other') // not Linux
  })
})

test.describe('which download is offered', () => {
  const offered = (env: Env): string | undefined => D.build(release(), env).primary?.asset.file

  test('the right build for every system we can identify', () => {
    expect(offered({ os: 'win', arch: null })).toBe('plexo-1.0.0-rc.7-setup.exe')
    expect(offered({ os: 'mac', arch: 'arm64' })).toBe('plexo-1.0.0-rc.7-arm64.dmg')
    expect(offered({ os: 'mac', arch: 'x64' })).toBe('plexo-1.0.0-rc.7-x64.dmg')
    expect(offered({ os: 'linux', arch: 'x64' })).toBe('plexo-1.0.0-rc.7-x86_64.AppImage')
    expect(offered({ os: 'linux', arch: 'arm64' })).toBe('plexo-1.0.0-rc.7-arm64.AppImage')
  })

  test('an undecided Mac gets Apple silicon, with the Intel build one click away and a hint', () => {
    const model = D.build(release(), { os: 'mac', arch: null })
    expect(model.primary?.asset.arch).toBe('arm64')
    expect(model.alternates.map((a) => a.asset.file)).toEqual(['plexo-1.0.0-rc.7-x64.dmg'])
    expect(model.hint).toMatch(/About This Mac/)
  })

  test('a build for a detected chip is never swapped for the other one', () => {
    for (const arch of ['arm64', 'x64'] as const) {
      for (const os of ['mac', 'linux'] as const) {
        expect(D.build(release(), { os, arch }).primary?.asset.arch).toBe(arch)
      }
    }
  })

  test('Linux offers the .deb beside the AppImage, of the same architecture', () => {
    const arm = D.build(release(), { os: 'linux', arch: 'arm64' })
    expect(arm.alternates.map((a) => a.asset.file)).toEqual(['plexo_1.0.0-rc.7_arm64.deb'])
    const unknown = D.build(release(), { os: 'linux', arch: null })
    expect(unknown.alternates.map((a) => a.asset.file)).toEqual([
      'plexo_1.0.0-rc.7_amd64.deb',
      'plexo-1.0.0-rc.7-arm64.AppImage'
    ])
  })

  test('phones and other systems get no download button, and every file is still listed', () => {
    const model = D.build(release(), { os: 'mobile', arch: null })
    expect(model.primary).toBeNull()
    expect(model.desktop).toBe(false)
    expect(model.groups.flatMap((g) => g.rows)).toHaveLength(SHIPPED.length)
  })

  test('a release missing a platform leaves it out, and a Windows-only visitor still gets the installer', () => {
    const windowsOnly = release(['plexo-1.0.0-rc.7-setup.exe'])
    expect(D.build(windowsOnly, { os: 'win', arch: null }).primary?.asset.os).toBe('win')
    expect(D.build(windowsOnly, { os: 'mac', arch: null }).primary).toBeNull()
    expect(D.build(windowsOnly, { os: 'mac', arch: null }).groups.map((g) => g.os)).toEqual(['win'])
    expect(D.build({ assets: [] }, { os: 'win', arch: null }).empty).toBe(true)
  })

  test('grouped by OS, in a fixed order, exactly one row recommended', () => {
    const model = D.build(release(), { os: 'linux', arch: 'x64' })
    expect(model.groups.map((g) => `${g.label}:${g.rows.length}`)).toEqual([
      'macOS:2',
      'Windows:1',
      'Linux:4'
    ])
    expect(model.groups[2].rows.map((r) => r.file)).toEqual([
      'plexo-1.0.0-rc.7-x86_64.AppImage',
      'plexo_1.0.0-rc.7_amd64.deb',
      'plexo-1.0.0-rc.7-arm64.AppImage',
      'plexo_1.0.0-rc.7_arm64.deb'
    ])
    expect(model.groups.flatMap((g) => g.rows).filter((r) => r.recommended)).toHaveLength(1)
    for (const group of model.groups) expect(group.notes.length).toBeGreaterThan(0)
  })

  test('release notes list every shipped file, once, under its name, and nothing else', () => {
    const files = SHIPPED.concat(NOISE).map((name) => ({
      name,
      size: 100 * 1048576,
      url: BASE + name
    }))
    const text = D.markdown(files, 'https://anmolkapil.github.io/plexo/')
    for (const name of SHIPPED) expect(text.split(BASE + name + ')')).toHaveLength(2)
    for (const name of NOISE) expect(text).not.toContain(name)
    expect(text).toContain('[Apple silicon]')
    expect(text).toContain('https://anmolkapil.github.io/plexo/#downloads')
    expect(text).toContain('`xattr -dr com.apple.quarantine /Applications/Plexo.app`')
  })
})

// --- the page itself -----------------------------------------------------------------------

async function openPage(
  browser: { userAgent: string; platform: string; maxTouchPoints?: number },
  options: { architecture?: 'arm' | 'x86'; releases?: unknown; apiStatus?: number } = {}
): Promise<{ page: Page; close: () => Promise<void> }> {
  const app = await electron.launch({
    args: [
      resolve(__dirname, 'page-host/main.cjs'),
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ],
    env: {
      ...(process.env as Record<string, string>),
      PAGE_SCENARIO: JSON.stringify({
        ...browser,
        architecture: options.architecture,
        apiStatus: options.apiStatus ?? 200,
        releases: options.releases ?? [release()]
      })
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(
    () => !document.querySelector('#release-meta')?.textContent?.trim().startsWith('Loading')
  )
  return { page, close: () => app.close() }
}

test.describe('the download page', () => {
  test('every build is listed under its OS and architecture with a direct link', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      await expect(page.locator('.os-panel .asset-link')).toHaveCount(SHIPPED.length)
      await expect(page.locator('.os-panel .download-size')).toHaveCount(SHIPPED.length)
      await expect(page.getByRole('tab', { name: 'Windows' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(page.locator('#primary-btn')).toHaveAttribute('href', BASE + SHIPPED[2])
      for (const [os, count] of [
        ['macOS', 2],
        ['Windows', 1],
        ['Linux', 4]
      ] as const) {
        await page.getByRole('tab', { name: os }).click()
        const panel = page.getByRole('tabpanel', { name: os })
        await expect(panel).toBeVisible()
        await expect(panel.locator('.asset-link')).toHaveCount(count)
        const hrefs = await panel
          .locator('.asset-link')
          .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href))
        for (const href of hrefs) expect(SHIPPED).toContain(href.split('/').pop())
        await expect(panel).toContainText(/Download/)
      }
      await expect(page.locator('#panel-mac h3')).toHaveText(['Apple silicon', 'Intel'])
      await expect(page.locator('#panel-linux h3')).toHaveText([
        'Intel / AMD',
        'Intel / AMD',
        'ARM64',
        'ARM64'
      ])
    } finally {
      await close()
    }
  })

  test('uncertain Mac architecture exposes both direct downloads without guessing', async () => {
    const { page, close } = await openPage(BROWSERS.safariMac)
    try {
      await expect(page.locator('#primary-btn')).toHaveAttribute('href', '#downloads')
      await expect(page.locator('#hero-download-info')).toContainText('can’t identify')
      await expect(page.locator('#hero-alternates a')).toHaveCount(2)
      await expect(page.locator('#hero-alternates a').first()).toHaveAttribute(
        'href',
        BASE + SHIPPED[1]
      )
      await expect(page.locator('#hero-alternates a').last()).toHaveAttribute(
        'href',
        BASE + SHIPPED[3]
      )
      await page.getByRole('link', { name: 'All downloads' }).click()
      await expect(page).toHaveURL(/#downloads$/)
      await expect(page.getByRole('tabpanel', { name: 'macOS' })).toBeVisible()
    } finally {
      await close()
    }
  })

  test('detected architecture downloads the matching build directly', async () => {
    const { page, close } = await openPage(BROWSERS.chromeMac, { architecture: 'x86' })
    try {
      await expect(page.locator('#primary-btn')).toHaveAttribute('href', BASE + SHIPPED[3])
      await expect(page.locator('#hero-download-info')).toHaveText(
        'Intel · Disk image (.dmg) · 93.0 MB · v1.0.0-rc.7'
      )
      await expect(page.locator('#hero-alternates a')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('mobile visitors get desktop choices instead of an incompatible direct download', async () => {
    const { page, close } = await openPage(BROWSERS.iphone)
    try {
      await expect(page.locator('#primary-btn')).toHaveAttribute('href', '#downloads')
      await expect(page.locator('#hero-download-info')).toHaveText(
        'Apple silicon · Disk image (.dmg) · 91.0 MB · v1.0.0-rc.7'
      )
    } finally {
      await close()
    }
  })

  test('each OS retains its installation guidance', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      await page.getByRole('tab', { name: 'macOS' }).click()
      const mac = page.getByRole('tabpanel', { name: 'macOS' })
      await mac.locator('summary').click()
      await expect(mac.locator('code')).toHaveText('xattr -cr /Applications/Plexo.app')
      await expect(mac).toContainText('Open Anyway')
      await page.getByRole('tab', { name: 'Windows' }).click()
      await page.getByRole('tabpanel', { name: 'Windows' }).locator('summary').click()
      await expect(page.getByRole('tabpanel', { name: 'Windows' })).toContainText('Run anyway')
      await page.getByRole('tab', { name: 'Linux' }).click()
      const linux = page.getByRole('tabpanel', { name: 'Linux' })
      await linux.locator('summary').click()
      await expect(linux).toContainText('libfuse2t64')
      await expect(linux).toContainText('kernel 5.7')
      const sectionGuide = await linux.locator('.install-guide-body').textContent()
      await page.evaluate(() => {
        document.addEventListener('click', (event) => event.preventDefault(), { once: true })
      })
      await linux.locator('.asset-link').first().click()
      const dialog = page.locator('#install-dialog')
      await expect(dialog).toBeVisible()
      expect(await dialog.locator('.install-guide-body').textContent()).toBe(sectionGuide)
      await expect(dialog.locator('.walkthrough-preview')).toHaveCount(0)
      await expect(page.locator('#release-meta')).toContainText('Latest pre-release')
      await expect(page.getByRole('link', { name: 'Previous releases' })).toHaveAttribute(
        'href',
        'https://github.com/anmolkapil/plexo/releases'
      )
      await expect(page.locator('.release-badge')).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('release content and URLs cannot inject executable markup', async () => {
    const hostile = release([
      'plexo-<img src=x onerror=document.title=1>-x64.dmg',
      'plexo-1.0.0-setup.exe'
    ]) as { tag_name: string; assets: { browser_download_url: string }[] }
    hostile.tag_name = '<img src=x onerror=document.title=1>'
    hostile.assets.push({ browser_download_url: 'javascript:alert(1)' })
    const { page, close } = await openPage(BROWSERS.chromeWindows, { releases: [hostile] })
    try {
      await expect(page.locator('#release-meta')).toContainText('<img src=x onerror=')
      await expect(page.locator('#downloads img')).toHaveCount(0)
      await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
      await expect(page).toHaveTitle(/Plexo/)
    } finally {
      await close()
    }
  })

  test('GitHub unreachable leaves usable links to release builds', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows, { apiStatus: 500 })
    try {
      await expect(page.locator('#release-meta')).toContainText('Couldn’t load')
      await expect(page.locator('#primary-btn')).toHaveAttribute('href', '#downloads')
      await expect(page.locator('#panel-win .asset-link')).toHaveAttribute(
        'href',
        'https://github.com/anmolkapil/plexo/releases'
      )
    } finally {
      await close()
    }
  })

  test('OS tabs support keyboard navigation', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      const windows = page.getByRole('tab', { name: 'Windows' })
      await windows.focus()
      await windows.press('ArrowRight')
      await expect(page.getByRole('tab', { name: 'Linux' })).toBeFocused()
      await expect(page.getByRole('tabpanel', { name: 'Linux' })).toBeVisible()
      await page.getByRole('tab', { name: 'Linux' }).press('Home')
      await expect(page.getByRole('tab', { name: 'macOS' })).toBeFocused()
    } finally {
      await close()
    }
  })

  test('navbar highlights the section currently in view', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      const currentLink = (section: string): Locator =>
        page.locator(`.navlinks a[href="#${section}"]`)

      await expect(page.locator('.navlinks [aria-current="location"]')).toHaveCount(0)
      await page
        .locator('#downloads')
        .evaluate((section) => section.scrollIntoView({ block: 'start' }))
      await expect(currentLink('downloads')).toHaveAttribute('aria-current', 'location')

      await page.locator('#faq').evaluate((section) => section.scrollIntoView({ block: 'start' }))
      await expect(currentLink('faq')).toHaveAttribute('aria-current', 'location')

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await expect(currentLink('support')).toHaveAttribute('aria-current', 'location')
    } finally {
      await close()
    }
  })

  test('phone and tablet layouts keep the demo and download actions in view', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('tab', { name: 'macOS' }).click()
      await expect(page.locator('.demo-flow-graphic')).toBeVisible()
      await expect(page.locator('.demo-chart')).toBeVisible()
      const flowBounds = await page.locator('.demo-flow-graphic').boundingBox()
      const totalBounds = await page.locator('.demo-total').boundingBox()
      const chartBounds = await page.locator('.demo-chart').boundingBox()
      expect(flowBounds?.x).toBeLessThan(totalBounds?.x ?? 0)
      expect(totalBounds?.x).toBeLessThan(chartBounds?.x ?? 0)
      const demoBounds = await page.locator('.demo-frame').boundingBox()
      expect(demoBounds?.width).toBeLessThanOrEqual(342)
      expect(demoBounds?.width).toBeGreaterThan(330)
      for (const tab of await page.locator('.os-tabs button').all()) {
        const padding = await tab.evaluate((button) => {
          const buttonRect = button.getBoundingClientRect()
          const iconRect = button.querySelector('svg')?.getBoundingClientRect()
          const labelRect = button.querySelector('span')?.getBoundingClientRect()
          return {
            left: (iconRect?.left ?? buttonRect.left) - buttonRect.left,
            right: buttonRect.right - (labelRect?.right ?? buttonRect.right)
          }
        })
        expect(padding.left).toBeGreaterThanOrEqual(12)
        expect(padding.right).toBeGreaterThanOrEqual(12)
      }
      await expect(page.locator('#panel-mac .asset-link')).toHaveCount(2)
      for (const card of await page.locator('#panel-mac .architecture-card').all()) {
        const bounds = await card.boundingBox()
        expect(bounds?.x).toBeGreaterThanOrEqual(0)
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390)
      }

      await page.locator('#menu-toggle').click()
      await expect(page.locator('#mobile-menu')).toBeVisible()
      expect((await page.locator('#mobile-menu').boundingBox())?.width).toBeGreaterThan(340)

      await page.setViewportSize({ width: 768, height: 1024 })
      const columns = await page
        .locator('#features .cells')
        .first()
        .evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length)
      expect(columns).toBe(2)
      for (const card of await page.locator('#panel-mac .architecture-card').all()) {
        const bounds = await card.boundingBox()
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(768)
      }
    } finally {
      await close()
    }
  })

  test('network toggles change speed and stop a transfer when both are off', async () => {
    const { page, close } = await openPage(BROWSERS.chromeWindows)
    try {
      await page.getByRole('button', { name: 'Pause demo' }).click()
      const combined = Number(await page.locator('#total-speed').textContent())
      await page.getByRole('checkbox', { name: 'Wi-Fi' }).uncheck()
      await expect(page.locator('#wifi-speed')).toHaveText('0.0 MB/s')
      expect(Number(await page.locator('#total-speed').textContent())).toBeLessThan(combined)
      await expect(page.locator('#usb-share')).toHaveText('100%')
      await page.getByRole('checkbox', { name: 'USB tethering' }).uncheck()
      await expect(page.locator('#total-speed')).toHaveText('0.0')
      await expect(page.locator('#time-left')).toHaveText('Waiting for a network')
      await page.getByRole('checkbox', { name: 'Wi-Fi' }).check()
      await expect(page.locator('#wifi-share')).toHaveText('100%')
      await expect(page.locator('#wifi-speed')).not.toHaveText('0.0 MB/s')
    } finally {
      await close()
    }
  })
})
