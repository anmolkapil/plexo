import { app } from 'electron'
import type { NetworkInterfaceInfo } from '../shared/types'

// Overrides for the end-to-end suite (e2e/), read from the environment. A packaged build ignores
// all of them, so a shipped app can't be steered through its environment variables.
const env: NodeJS.ProcessEnv = app.isPackaged ? {} : process.env

function positiveNumber(name: string, fallback: number): number {
  const value = Number(env[name])
  return value > 0 ? value : fallback
}

export const testKnobs = {
  userDataDir: env['PLEXO_USER_DATA'],
  /** Keeps the window off-screen so a test run doesn't pop windows up over the desktop. */
  hideWindow: env['PLEXO_E2E_HIDE_WINDOW'] === '1',
  blockBytes: positiveNumber('PLEXO_E2E_BLOCK_BYTES', 8 * 1024 * 1024),
  retryBaseDelayMs: positiveNumber('PLEXO_E2E_RETRY_BASE_MS', 1000),
  stallTimeoutMs: positiveNumber('PLEXO_E2E_STALL_MS', 20_000),
  slowWarmupMs: positiveNumber('PLEXO_E2E_SLOW_WARMUP_MS', 5_000),
  slowForMs: positiveNumber('PLEXO_E2E_SLOW_FOR_MS', 10_000),
  silentAfterMs: positiveNumber('PLEXO_E2E_SILENT_MS', 5_000),
  hedgeAfterMs: positiveNumber('PLEXO_E2E_HEDGE_MS', 5_000),
  /** Skips the real GitHub check and pretends this version is available, for exercising the
   * update banner without needing an actual newer release published. */
  forceUpdateVersion: env['PLEXO_FORCE_UPDATE_VERSION']
}

/** `PLEXO_E2E_INTERFACES=a=127.0.0.1,b=192.168.1.5` replaces the real interface list. Read on
 * every call rather than once, so a test can make a network "disappear" mid-download by
 * rewriting process.env in the main process. */
export function testInterfaces(): NetworkInterfaceInfo[] | null {
  if (app.isPackaged) return null
  const raw = process.env['PLEXO_E2E_INTERFACES']
  if (raw === undefined) return null
  return raw
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, address] = entry.split('=')
      return { id, device: id, displayName: id, address, kind: 'ethernet' as const }
    })
}
