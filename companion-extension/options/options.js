import { checkPlexoHealth } from '../background/client.js'
import { DEFAULT_EXTENSIONS, DEFAULT_SETTINGS } from '../background/rules.js'

let activeSettings = { ...DEFAULT_SETTINGS }

const connectionBadge = document.getElementById('connection-badge')
const captureModeRadios = document.getElementsByName('captureMode')
const extensionsSection = document.getElementById('extensions-section')
const chipsContainer = document.getElementById('chips-container')
const newExtInput = document.getElementById('new-ext-input')
const addExtBtn = document.getElementById('add-ext-btn')
const minSizeInput = document.getElementById('min-size-input')
const excludedDomainsInput = document.getElementById('excluded-domains-input')
const portInput = document.getElementById('port-input')
const testConnBtn = document.getElementById('test-conn-btn')
const testResult = document.getElementById('test-result')
const saveBtn = document.getElementById('save-btn')
const resetBtn = document.getElementById('reset-btn')
const saveStatus = document.getElementById('save-status')

async function init() {
  const data = await chrome.storage.local.get(['plexoSettings'])
  if (data.plexoSettings) {
    activeSettings = { ...DEFAULT_SETTINGS, ...data.plexoSettings }
  } else {
    activeSettings = { ...DEFAULT_SETTINGS }
  }

  renderSettings()
  await testConnection(activeSettings.port, false)
}

function renderSettings() {
  // Capture Mode
  for (const radio of captureModeRadios) {
    radio.checked = radio.value === activeSettings.captureMode
  }
  updateSectionVisibility()

  // Chips
  renderChips()

  // Min size
  minSizeInput.value = activeSettings.minSizeMb || 0

  // Excluded domains
  excludedDomainsInput.value = (activeSettings.excludedDomains || []).join('\n')

  // Port
  portInput.value = activeSettings.port || 41829
}

function updateSectionVisibility() {
  const isExtensionMode = document.querySelector('input[name="captureMode"]:checked')?.value === 'extension_list'
  extensionsSection.style.opacity = isExtensionMode ? '1' : '0.5'
  extensionsSection.style.pointerEvents = isExtensionMode ? 'auto' : 'none'
}

function renderChips() {
  chipsContainer.innerHTML = ''
  for (const ext of activeSettings.extensions) {
    const chip = document.createElement('div')
    chip.className = 'chip'
    chip.innerHTML = `
      <span>.${ext}</span>
      <button class="chip-remove" title="Remove">&times;</button>
    `
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      activeSettings.extensions = activeSettings.extensions.filter((e) => e !== ext)
      renderChips()
    })
    chipsContainer.appendChild(chip)
  }
}

function addExtension() {
  const raw = newExtInput.value.trim().toLowerCase().replace(/^\./, '')
  if (!raw) return

  const parts = raw.split(/[\s,]+/).filter(Boolean)
  for (const part of parts) {
    if (!activeSettings.extensions.includes(part)) {
      activeSettings.extensions.push(part)
    }
  }
  newExtInput.value = ''
  renderChips()
}

addExtBtn.addEventListener('click', addExtension)
newExtInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    addExtension()
  }
})

for (const radio of captureModeRadios) {
  radio.addEventListener('change', () => {
    activeSettings.captureMode = radio.value
    updateSectionVisibility()
  })
}

async function testConnection(port, showText = true) {
  if (showText) {
    testResult.textContent = 'Testing…'
    testResult.className = 'test-result'
  }
  connectionBadge.className = 'badge checking'
  connectionBadge.textContent = 'Checking…'

  const res = await checkPlexoHealth(port)
  if (res.online) {
    connectionBadge.className = 'badge online'
    connectionBadge.textContent = 'Connected (Plexo ' + (res.version || 'Desktop') + ')'
    if (showText) {
      testResult.textContent = 'Success! Connected to Plexo.'
      testResult.className = 'test-result success'
    }
  } else {
    connectionBadge.className = 'badge offline'
    connectionBadge.textContent = 'Offline'
    if (showText) {
      testResult.textContent = 'Could not reach Plexo on port ' + port + '.'
      testResult.className = 'test-result error'
    }
  }
}

testConnBtn.addEventListener('click', () => {
  const port = parseInt(portInput.value, 10) || 41829
  void testConnection(port, true)
})

saveBtn.addEventListener('click', async () => {
  activeSettings.captureMode = document.querySelector('input[name="captureMode"]:checked')?.value || 'extension_list'
  activeSettings.minSizeMb = Math.max(0, parseInt(minSizeInput.value, 10) || 0)
  activeSettings.port = parseInt(portInput.value, 10) || 41829

  const domainLines = excludedDomainsInput.value
    .split('\n')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
  activeSettings.excludedDomains = Array.from(new Set(domainLines))

  await chrome.storage.local.set({ plexoSettings: activeSettings })

  saveStatus.textContent = 'Settings saved!'
  setTimeout(() => {
    saveStatus.textContent = ''
  }, 2000)

  void testConnection(activeSettings.port, false)
})

resetBtn.addEventListener('click', () => {
  if (confirm('Reset all companion settings to defaults?')) {
    activeSettings = { ...DEFAULT_SETTINGS, extensions: [...DEFAULT_EXTENSIONS] }
    renderSettings()
  }
})

void init()
