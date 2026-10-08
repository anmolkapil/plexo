import { reach } from './plexo'
import { excluded, loadSettings, saveSettings } from './settings'

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const ALL_SITES = { origins: ['<all_urls>'] }

async function activeHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab?.url && /^https?:/i.test(tab.url) ? new URL(tab.url).hostname : null
}

async function render(): Promise<void> {
  const [settings, host, reached, access] = await Promise.all([
    loadSettings(),
    activeHost(),
    reach(),
    // Firefox lets the user withhold site access, which reading a site's cookies needs.
    chrome.permissions.contains(ALL_SITES)
  ])
  const [tone, text] =
    reached === 'closed'
      ? ['', 'Plexo not open']
      : reached === 'update'
        ? ['warn', 'Update Plexo']
        : settings.capture
          ? ['ok', 'Connected']
          : ['', 'Capture off']
  element('status-dot').className = `dot ${tone}`
  element('status-text').textContent = text
  element('access').hidden = access
  element('closed').hidden = reached !== 'closed'

  element<HTMLInputElement>('capture').checked = settings.capture
  element('capture-hint').textContent = settings.capture
    ? 'Downloads open in Plexo instead of the browser.'
    : 'Downloads stay in the browser.'

  element('site-row').hidden = host === null
  if (host) {
    const on = !excluded(settings.sites, [`https://${host}/`])
    const site = element<HTMLInputElement>('site')
    site.checked = on && settings.capture
    site.disabled = !settings.capture
    element('site-host').textContent = host
    element('site-hint').textContent = !settings.capture
      ? 'Capture is off everywhere.'
      : on
        ? 'Downloads from this site go to Plexo.'
        : 'Downloads from this site stay in the browser.'
  }
}

element<HTMLInputElement>('capture').addEventListener('change', (event) => {
  void saveSettings({ capture: (event.target as HTMLInputElement).checked })
})

element<HTMLInputElement>('site').addEventListener('change', async (event) => {
  const host = await activeHost()
  if (!host) return
  const { sites } = await loadSettings()
  // A parent domain's rule covers this site too, so turning it back on drops that as well.
  const covering = (site: string): boolean => host === site || host.endsWith(`.${site}`)
  await saveSettings({
    sites: (event.target as HTMLInputElement).checked
      ? sites.filter((site) => !covering(site))
      : [...sites, host]
  })
})

element('grant').addEventListener('click', () => {
  void chrome.permissions.request(ALL_SITES).then(render)
})
element('open-plexo').addEventListener('click', () => {
  void chrome.runtime.sendMessage({ wakePlexo: true })
})
element('options').addEventListener('click', () => void chrome.runtime.openOptionsPage())

chrome.storage.onChanged.addListener(() => void render())
void render()
// So the toolbar icon agrees with the popup now, not at its next check.
void chrome.runtime.sendMessage({ checkPlexo: true }).catch(() => {})
