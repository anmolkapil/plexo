// Opens the real docs/index.html in a hidden window, as a visitor with a given browser would see
// it. The scenario (PAGE_SCENARIO) says what GitHub's API answers and what the browser reports.
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')

const scenario = JSON.parse(process.env.PAGE_SCENARIO)

app.whenReady().then(async () => {
  session.defaultSession.protocol.handle('https', (request) => {
    if (new URL(request.url).hostname === 'api.github.com') {
      return scenario.apiStatus === 200
        ? Response.json(scenario.releases)
        : new Response('', { status: scenario.apiStatus })
    }
    return new Response('', { status: 404 }) // fonts and anything else: not needed
  })

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // The preload has to change what the page's own scripts see.
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  })
  win.webContents.setUserAgent(scenario.userAgent)
  await win.loadFile(path.resolve(__dirname, '../../docs/index.html'))
})
