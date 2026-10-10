import { api } from './api'
import { plexoPort, reach } from './plexo'
import { loadSettings, saveSettings, siteOf } from './settings'

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

async function render(): Promise<void> {
  const settings = await loadSettings()
  element<HTMLInputElement>('capture').checked = settings.capture
  element<HTMLInputElement>('skip-small').checked = settings.skipSmall
  const minimum = element<HTMLInputElement>('min-mb')
  minimum.value = String(settings.minMegabytes)
  minimum.disabled = !settings.skipSmall

  const list = element('sites')
  list.replaceChildren(
    ...settings.sites.map((site) => {
      const item = document.createElement('li')
      const name = document.createElement('span')
      name.textContent = site
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ghost'
      remove.textContent = 'Remove'
      remove.setAttribute('aria-label', `Remove ${site}`)
      remove.addEventListener('click', () => {
        void saveSettings({ sites: settings.sites.filter((other) => other !== site) })
      })
      item.append(name, remove)
      return item
    })
  )
  element('no-sites').hidden = settings.sites.length > 0
}

async function renderConnection(): Promise<void> {
  const reached = await reach()
  element('dot').className = `dot ${reached === 'ok' ? 'ok' : reached === 'update' ? 'warn' : ''}`
  element('connection').textContent =
    reached === 'ok'
      ? 'Connected to Plexo'
      : reached === 'update'
        ? 'Update Plexo to use this extension'
        : 'Plexo isn’t open'
  element('open-plexo').hidden = reached !== 'closed'
  const port = plexoPort()
  element('port').textContent = port === null ? '' : `127.0.0.1:${port}`
}

element<HTMLInputElement>('capture').addEventListener('change', (event) => {
  void saveSettings({ capture: (event.target as HTMLInputElement).checked })
})
element<HTMLInputElement>('skip-small').addEventListener('change', (event) => {
  void saveSettings({ skipSmall: (event.target as HTMLInputElement).checked })
})
element<HTMLInputElement>('min-mb').addEventListener('change', (event) => {
  const megabytes = Math.round(Number((event.target as HTMLInputElement).value))
  if (megabytes >= 1) void saveSettings({ minMegabytes: megabytes })
  else void render()
})

element<HTMLFormElement>('add-site').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = element<HTMLInputElement>('site')
  const site = siteOf(input.value)
  element('site-error').hidden = site !== null || input.value.trim() === ''
  if (!site) return
  const { sites } = await loadSettings()
  if (!sites.includes(site)) await saveSettings({ sites: [...sites, site] })
  input.value = ''
})

element('open-plexo').addEventListener('click', () => {
  void api.runtime.sendMessage({ wakePlexo: true }).then(() => setTimeout(renderConnection, 4000))
})

element('version').textContent = `Extension ${api.runtime.getManifest().version}`
api.storage.onChanged.addListener(() => void render())
void render()
void renderConnection()
