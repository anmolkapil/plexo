/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function --
   the double's shape: interface-conforming args it doesn't need, and steps that are no-ops. */
import type {
  TelegramAuthState,
  TelegramCredentials,
  TelegramMediaItem,
  TelegramMediaPage,
  TelegramMediaType
} from '../../shared/types'
import { testKnobs } from '../testKnobs'
import type { TelegramFileSource } from '../download/telegramTransfer'
import { TelegramFileError } from '../download/telegramTransfer'
import type { TelegramServiceApi } from './service'

/**
 * The Telegram service's double for end-to-end tests (PLEXO_E2E_TELEGRAM_FAKE=1): signs in
 * instantly, lists a page of Saved Messages media that isn't really there, and serves its
 * bytes the way a DC would — including the faults the real one inflicts (FLOOD_WAITs, stale
 * file references, per-region caps on the request size, a photo whose size only the download
 * learns). The transfer and the manager run against it unchanged, which is the point.
 */

const KB = 1024

interface FakeFile {
  messageId: number
  type: TelegramMediaType
  name: string
  mimeType: string
  /** 0 marks a photo: its size is only known once the download reaches its end. */
  size: number
  seed: number
  /** The first request this many times answers with a FLOOD_WAIT of one second. */
  floodWaits?: number
  /** The first request this many times answers with a stale file reference. */
  staleReference?: number
  /** Requests larger than this answer LIMIT_INVALID — a per-region cap, as the real server. */
  limitCap?: number
}

const FAKE_MEDIA: FakeFile[] = [
  {
    messageId: 1,
    type: 'video',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
    size: 3 * KB * KB,
    seed: 11
  },
  { messageId: 2, type: 'photo', name: 'shot.jpg', mimeType: 'image/jpeg', size: 0, seed: 22 },
  {
    messageId: 3,
    type: 'document',
    name: 'flaky.zip',
    mimeType: 'application/zip',
    size: 3 * KB * KB,
    seed: 33,
    floodWaits: 1,
    staleReference: 1,
    limitCap: 64 * KB
  }
]

/** The photo's real length: the download learns it at the empty answer. */
const PHOTO_ACTUAL_BYTES = 2 * KB * KB

/** xorshift32 — the same deterministic pattern the test origin serves. */
class SeededBytes {
  private state: number
  constructor(seed: number) {
    this.state = seed >>> 0 || 1
  }
  next(): number {
    this.state ^= this.state << 13
    this.state ^= this.state >>> 17
    this.state ^= this.state << 5
    return this.state & 0xff
  }
  slice(offset: number, length: number): Buffer {
    // Walks to the offset rather than storing megabytes nobody reads in a test.
    const walker = new SeededBytes(this.state)
    for (let at = 0; at < offset; at++) walker.next()
    const out = Buffer.alloc(length)
    for (let i = 0; i < length; i++) out[i] = walker.next()
    return out
  }
}

class FakeFileSource {
  private requests = 0
  private readonly generator: SeededBytes
  constructor(private readonly file: FakeFile) {
    this.generator = new SeededBytes(file.seed)
  }

  get unknownSize(): boolean {
    return this.file.size === 0
  }

  /** The photo's real length; a known file's length. */
  get servedBytes(): number {
    return this.file.size === 0 ? PHOTO_ACTUAL_BYTES : this.file.size
  }

  async request(offset: number, limit: number, _signal?: AbortSignal): Promise<Buffer> {
    this.requests += 1
    if (testKnobs.telegramDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, testKnobs.telegramDelayMs))
    }
    if (this.file.staleReference !== undefined && this.requests <= this.file.staleReference) {
      throw new TelegramFileError('other', 'FILE_REFERENCE_EXPIRED')
    }
    if (this.file.floodWaits !== undefined && this.requests <= this.file.floodWaits) {
      throw new TelegramFileError('rate', 'FLOOD_WAIT_1', 1)
    }
    if (this.file.limitCap !== undefined && limit > this.file.limitCap) {
      throw new TelegramFileError('other', 'LIMIT_INVALID')
    }
    if (offset >= this.servedBytes) return Buffer.alloc(0)
    return this.generator.slice(offset, Math.min(limit, this.servedBytes - offset))
  }

  /** The transfer re-locates the file over a stale reference through this (see
   * telegramTransfer.ts): the double marks the reference fresh again, and the retry that
   * follows succeeds — the same contract the real service's re-locate keeps. */
  async refresh(): Promise<void> {
    if (this.file.staleReference !== undefined) {
      this.requests = Math.max(this.requests, this.file.staleReference)
    }
  }
}

export class FakeTelegramService implements TelegramServiceApi {
  private auth: TelegramAuthState = {
    signedIn: false,
    awaitingCode: false,
    awaitingPassword: false
  }
  onChange: ((state: TelegramAuthState) => void) | undefined

  private push(update: Partial<TelegramAuthState>): void {
    this.auth = { ...this.auth, ...update, error: undefined }
    this.onChange?.(this.authState())
  }

  authState(): TelegramAuthState {
    return structuredClone(this.auth)
  }

  /** Nothing to restore: a fresh fake starts signed out, and the spec signs in. */
  async restore(): Promise<void> {}

  async startLogin(_credentials: TelegramCredentials): Promise<void> {
    this.push({
      signedIn: true,
      hasOwnKeys: true,
      apiId: _credentials.apiId,
      phone: _credentials.phone,
      userName: 'Fake User'
    })
  }

  async startQrLogin(): Promise<void> {
    this.push({ signedIn: true, hasOwnKeys: false, userName: 'Fake User' })
  }

  async submitCode(_code: string): Promise<void> {}

  async submitPassword(_password: string): Promise<void> {}

  async logout(): Promise<void> {
    this.push({
      signedIn: false,
      hasOwnKeys: false,
      apiId: undefined,
      phone: undefined,
      userName: undefined
    })
  }

  async listMediaPage(_offsetId?: number, _limit?: number): Promise<TelegramMediaPage> {
    const items: TelegramMediaItem[] = FAKE_MEDIA.map((file) => ({
      messageId: file.messageId,
      type: file.type,
      fileName: file.name,
      mimeType: file.mimeType,
      totalBytes: file.size,
      ...(file.type === 'video' ? { width: 1280, height: 720 } : {}),
      date: Math.floor(Date.now() / 1000) - file.messageId * 3600
    }))
    return { items, exhausted: true }
  }

  async mediaInfo(messageId: number): Promise<{
    fileName: string
    totalBytes: number
    mimeType: string
    mediaType: TelegramMediaType
  }> {
    const file = FAKE_MEDIA.find((entry) => entry.messageId === messageId)
    if (!file) throw new Error("That message's media is gone from Saved Messages.")
    return {
      fileName: file.name,
      totalBytes: file.size,
      mimeType: file.mimeType,
      mediaType: file.type
    }
  }

  async fileSource(messageId: number): Promise<TelegramFileSource> {
    const file = FAKE_MEDIA.find((entry) => entry.messageId === messageId)
    if (!file)
      throw new TelegramFileError('missing', "That message's media is gone from Saved Messages.")
    const source = new FakeFileSource(file)
    return {
      get unknownSize(): boolean {
        return source.unknownSize
      },
      request: (offset: number, limit: number, signal?: AbortSignal) =>
        source.request(offset, limit, signal),
      refresh: (): Promise<void> => source.refresh(),
      dispose: async (): Promise<void> => {}
    }
  }
}
