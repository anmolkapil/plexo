import { checkPlexoHealth, sendDownloadToPlexo } from '../background/client.js'

const statusPill = document.getElementById('status-pill')
const statusText = document.getElementById('status-text')
const captureToggle = document.getElementById('capture-toggle')
const linkInput = document.getElementById('link-input')
const sendBtn = document.getElementById('send-btn')
const linkMessage = document.getElementById('link-message')
const openAppBtn = document.getElementById('open-app-btn')
const optionsBtn = document.getElementById('options-btn')

let currentSettings = { enabled: true, port: 41829 }

async function init() {
  const data = await chrome.storage.local.get(['plexoSettings'])
  if (data.plexoSettings) {
    currentSettings = { ...currentSettings, ...data.plexoSettings }
  }
  captureToggle.checked = currentSettings.enabled !== false

  await updateHealth()
}

async function updateHealth() {
  const health = await checkPlexoHealth(currentSettings.port)
  if (health.online) {
    if (health.hasActiveDownload) {
      statusPill.className = 'status-pill online active'
      statusText.textContent = 'Transfer Active'
    } else {
      statusPill.className = 'status-pill online'
      statusText.textContent = 'Connected'
    }
  } else {
    statusPill.className = 'status-pill offline'
    statusText.textContent = 'Plexo Offline'
  }
}

captureToggle.addEventListener('change', async () => {
  currentSettings.enabled = captureToggle.checked
  await chrome.storage.local.set({ plexoSettings: currentSettings })
})

sendBtn.addEventListener('click', async () => {
  const url = linkInput.value.trim()
  if (!url) return

  if (!/^https?:/i.test(url)) {
    showMessage('Please enter a valid http or https URL.', 'error')
    return
  }

  showMessage('Sending to Plexo…', '')
  const result = await sendDownloadToPlexo({ url }, currentSettings.port)

  if (result.success) {
    showMessage('Sent to Plexo successfully!', 'success')
    linkInput.value = ''
    setTimeout(() => {
      window.close()
    }, 1000)
  } else {
    showMessage(result.error || 'Failed to send to Plexo. Is the app running?', 'error')
  }
})

linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendBtn.click()
  }
})

openAppBtn.addEventListener('click', () => {
  // Launch Plexo via custom protocol
  window.location.href = 'plexo://open'
})

optionsBtn.addEventListener('click', () => {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage()
  } else {
    window.open(chrome.runtime.getURL('options/options.html'))
  }
})

function showMessage(text, type) {
  linkMessage.textContent = text
  linkMessage.className = `message ${type}`
}

void init()
