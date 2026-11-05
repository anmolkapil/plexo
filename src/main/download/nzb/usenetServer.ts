import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { UsenetServer, UsenetServerInput } from '../../../shared/types'
import { readJson, updateJson } from '../../jsonFile'

/** A news server, with what only the main process may see: its password. */
export type NewsServerConfig = Omit<
  UsenetServer,
  'enabled' | 'backup' | 'hasPassword' | 'passwordInMemory'
> & {
  password: string
  /** Its password as sealed, when this session can't unseal it (no keyring yet, another
   * keychain): written back as it is, so a session that can still has it. */
  unread?: string
}

/** The news server, and the backup for the articles it doesn't have. */
export interface UsenetServerConfig extends NewsServerConfig {
  enabled: boolean
  backup?: NewsServerConfig
}

/** What providers allow: rarely past 50 connections an account. */
export const MAX_CONNECTIONS = 100
export const DEFAULT_CONNECTIONS = 8

export const USENET_OFF = 'Usenet downloads are off. Turn them on in Speed & data limits.'

function serverPath(): string {
  return join(app.getPath('userData'), 'usenet-server.json')
}

/** The passwords, when this computer has no keychain to seal them with: kept until Plexo quits. */
const inMemory: { main?: string; backup?: string } = {}

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
export function checkedServer(value: unknown): Omit<NewsServerConfig, 'password'> | null {
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

/** A server as saved, its password unsealed; null when it isn't one. */
function loaded(saved: unknown, role: keyof typeof inMemory): NewsServerConfig | null {
  const server = checkedServer(saved)
  if (!server || !isRecord(saved)) return null
  let password = inMemory[role] ?? ''
  let unread = typeof saved.password === 'string' ? saved.password : undefined
  if (unread && canSeal()) {
    try {
      password = safeStorage.decryptString(Buffer.from(unread, 'base64'))
      unread = undefined
    } catch {
      // Sealed by another keychain (a restored profile, say): it has to be entered again.
    }
  }
  return { ...server, password, ...(unread && { unread }) }
}

/** The news server set up, with its backup if it has one, passwords included; null when there's
 * none. */
export async function loadUsenetServer(): Promise<UsenetServerConfig | null> {
  const saved = await readJson(serverPath()).catch(() => undefined)
  const server = loaded(saved, 'main')
  if (!server || !isRecord(saved)) return null
  const backup = loaded(saved.backup, 'backup')
  // Saved before there was a switch: on.
  return { ...server, enabled: saved.enabled !== false, ...(backup && { backup }) }
}

/** As the window may see it. */
export function viewOf(server: UsenetServerConfig): UsenetServer {
  const view = ({
    password,
    unread,
    ...rest
  }: NewsServerConfig): Omit<UsenetServer, 'enabled'> => ({
    ...rest,
    // One this session can't unseal is still saved: left blank, it stays.
    hasPassword: password !== '' || unread !== undefined,
    ...(!canSeal() && { passwordInMemory: true })
  })
  const { enabled, backup, ...main } = server
  return { ...view(main), enabled, ...(backup && { backup: view(backup) }) }
}

/** Whether NZBs download from Usenet: on until switched off, which takes a server set up. */
export async function usenetEnabled(): Promise<boolean> {
  // Only the switch: no password to unseal for it.
  const saved = await readJson(serverPath()).catch(() => undefined)
  return !(isRecord(saved) && checkedServer(saved) && saved.enabled === false)
}

/** The server (or the backup) as `input` sets it: the password it gives, or, when it gives none,
 * the one saved for the same host and username. */
export async function serverFromInput(
  input: UsenetServerInput,
  backup = false
): Promise<NewsServerConfig> {
  const server = checkedServer(input)
  if (!server) throw new Error('Enter the news server’s address')
  if (input.password !== undefined && /[\r\n]/.test(input.password)) {
    throw new Error('A password can’t span lines')
  }
  const saved = await loadUsenetServer()
  const kept = backup ? saved?.backup : saved
  // A password never goes to another server or account. Port and SSL may change: the same
  // provider takes the same login on each of its ports.
  const same = kept?.host === server.host && kept.username === server.username
  if (input.password !== undefined || !same) return { ...server, password: input.password ?? '' }
  return { ...server, password: kept.password, ...(kept.unread && { unread: kept.unread }) }
}

/** Sets the news server, keeping its backup; its switch as `input` gives it, or as saved. */
export async function saveUsenetServer(input: UsenetServerInput): Promise<UsenetServer> {
  const server = await serverFromInput(input)
  const saved = await loadUsenetServer()
  return write({
    ...server,
    enabled: input.enabled ?? saved?.enabled ?? true,
    ...(saved?.backup && { backup: saved.backup })
  })
}

/** Sets the backup server, or removes it (null). It backs up the news server: there must be one. */
export async function saveUsenetBackup(input: UsenetServerInput | null): Promise<UsenetServer> {
  const saved = await loadUsenetServer()
  if (!saved) throw new Error('Set up the news server first')
  return write({ ...saved, backup: input ? await serverFromInput(input, true) : undefined })
}

async function write(server: UsenetServerConfig): Promise<UsenetServer> {
  const { enabled, backup, ...main } = server
  if (!backup) inMemory.backup = undefined
  const file = {
    ...sealed(main, 'main'),
    enabled,
    ...(backup && { backup: sealed(backup, 'backup') })
  }
  await updateJson(serverPath(), () => file)
  return viewOf(server)
}

/** As the file keeps it: the password sealed, or not at all (kept for this session instead). */
function sealed(
  { password, unread, ...fields }: NewsServerConfig,
  role: keyof typeof inMemory
): Omit<NewsServerConfig, 'password'> & { password?: string } {
  let sealed: string | undefined
  if (canSeal() && password) {
    try {
      sealed = safeStorage.encryptString(password).toString('base64')
    } catch {
      // The keychain refused: kept for this session instead.
    }
  }
  inMemory[role] = sealed === undefined ? password || undefined : undefined
  // Nothing new to seal: a password sealed by a keychain this session can't use stays as it is.
  const kept = sealed ?? (password ? undefined : unread)
  return { ...fields, ...(kept && { password: kept }) }
}
