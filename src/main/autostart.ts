import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { testKnobs } from './testKnobs'

export interface AutostartOptions {
  openAtLogin: boolean
  startMinimized?: boolean
}

function autostartDesktopPath(): string {
  if (testKnobs.userDataDir) {
    return join(testKnobs.userDataDir, 'autostart', 'plexo.desktop')
  }
  return join(homedir(), '.config', 'autostart', 'plexo.desktop')
}

/**
 * Configures the application to launch at system startup on Windows, macOS, and Linux.
 * - Windows: Uses Electron's built-in setLoginItemSettings (Windows Registry: HKCU\...\Run).
 * - macOS: Uses Electron's built-in setLoginItemSettings (macOS Login Items / ServiceManagement).
 * - Linux: Follows the XDG Autostart specification by managing ~/.config/autostart/plexo.desktop.
 */
export async function applyAutostart(options: AutostartOptions): Promise<void> {
  const { openAtLogin, startMinimized } = options

  if (process.platform === 'win32') {
    try {
      app.setLoginItemSettings({
        openAtLogin,
        args: startMinimized ? ['--minimized'] : []
      })
    } catch (error) {
      console.error('[plexo] failed to set Windows login item settings', error)
    }
    return
  }

  if (process.platform === 'darwin') {
    try {
      app.setLoginItemSettings({
        openAtLogin
      })
    } catch (error) {
      console.error('[plexo] failed to set macOS login item settings', error)
    }
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = autostartDesktopPath()
    try {
      if (openAtLogin) {
        await mkdir(dirname(desktopPath), { recursive: true })
        const executable = process.env.APPIMAGE || process.execPath
        const execArgs = startMinimized ? ' --minimized' : ''
        const content =
          [
            '[Desktop Entry]',
            'Type=Application',
            'Version=1.0',
            'Name=Plexo',
            'Comment=Plexo Download Manager',
            `Exec=${executable}${execArgs}`,
            'StartupNotify=false',
            'Terminal=false'
          ].join('\n') + '\n'
        await writeFile(desktopPath, content, 'utf8')
      } else {
        await rm(desktopPath, { force: true }).catch(() => {})
      }
    } catch (error) {
      console.error('[plexo] failed to configure Linux autostart desktop entry', error)
    }
  }
}

/** Queries whether the application is currently registered to launch at startup. */
export function isAutostartRegistered(): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().openAtLogin
    } catch {
      return false
    }
  }
  if (process.platform === 'linux') {
    return existsSync(autostartDesktopPath())
  }
  return false
}
