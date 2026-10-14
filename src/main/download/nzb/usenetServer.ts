import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { UsenetServer, UsenetServerInput } from '../../../shared/types'
import { readJson, updateJson } from '../../jsonFile'

/** The news server, with what only the main process may see: its password. */
export interface UsenetServerConfig extends Omit<UsenetServer, 'hasPassword' | 'passwordInMemory'> {
  password: string
}

/** What providers allow: rarely past 50 connections an account. */
export const MAX_CONNECTIONS = 100
export const DEFAULT_CONNECTIONS = 8

function serverPath(): string {
  return join(app.getPath('userData'), 'usenet-server.json')
}

/** The password, when this computer has no keychain to seal it with: kept until Plexo quits. */
let inMemory: string | undefined

/** As for the browser's cookies (see sealBrowser in downloadManager.ts): never written in the
 * clear, and on Linux without a keyring, not written at all. */
function canSeal(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only fields of the right type and range: the file may be hand-edited, the input is the
 * window's. A host is all that's needed for the rest to make sense. */
export function checkedServer(value: unknown): Omit<UsenetServerConfig, 'password'> | null {
  if (!isRecord(value)) return null
  const host = typeof value.host === 'string' ? value.host.trim() : ''
  // A host name or an address, nothing a command line or URL could make more of.
  if (!host || !/^[\w.:[\]-]+$/.test(host) || host.length > 253) return null
  const tls = value.tls !== false
  const port = Number(value.port)
  const connections = Number(value.connections)
  const username = typeof value.username === 'string' ? value.username.trim() : ''
  if (/[\r\n]/.test(username)) return null
  return {
    host: host.replace(/^\[|\]$/g, ''),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : tls ? 563 : 119,
    tls,
    username,
    connections:
      Number.isInteger(connections) && connections >= 1
        ? Math.min(connections, MAX_CONNECTIONS)
        : DEFAULT_CONNECTIONS
  }
}

/** The news server set up, password included; null when there's none. */
export async function loadUsenetServer(): Promise<UsenetServerConfig | null> {
  const saved = await readJson(serverPath()).catch(() => undefined)
  const server = checkedServer(saved)
  if (!server || !isRecord(saved)) return null
  let password = inMemory ?? ''
  if (typeof saved.password === 'string' && canSeal()) {
    try {
      password = safeStorage.decryptString(Buffer.from(saved.password, 'base64'))
    } catch {
      // Sealed by another keychain (a restored profile, say): it has to be entered again.
    }
  }
  return { ...server, password }
}

/** As the window may see it. */
export function viewOf(server: UsenetServerConfig): UsenetServer {
  const { password, ...rest } = server
  return { ...rest, hasPassword: password !== '', ...(!canSeal() && { passwordInMemory: true }) }
}

/** The server as `input` sets it: the password it gives, or the one saved when it gives none. */
export async function serverFromInput(input: UsenetServerInput): Promise<UsenetServerConfig> {
  const server = checkedServer(input)
  if (!server) throw new Error('Enter the news server’s address')
  if (input.password !== undefined && /[\r\n]/.test(input.password)) {
    throw new Error('A password can’t span lines')
  }
  const password = input.password ?? (await loadUsenetServer())?.password ?? ''
  return { ...server, password }
}

export async function saveUsenetServer(input: UsenetServerInput): Promise<UsenetServer> {
  const server = await serverFromInput(input)
  const { password, ...rest } = server
  let sealed: string | undefined
  if (canSeal() && password) {
    try {
      sealed = safeStorage.encryptString(password).toString('base64')
    } catch {
      // The keychain refused: kept for this session instead.
    }
  }
  inMemory = sealed === undefined ? password || undefined : undefined
  await updateJson(serverPath(), () => ({ ...rest, ...(sealed && { password: sealed }) }))
  return viewOf(server)
}
