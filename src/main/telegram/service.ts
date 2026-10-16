import { Api, TelegramClient } from 'telegram'
import { LAYER } from 'telegram/tl/AllTLObjects'
import { StringSession } from 'telegram/sessions'
import { sendCode } from 'telegram/client/auth'
import { computeCheck } from 'telegram/Password'
import { FloodWaitError, FileMigrateError } from 'telegram/errors'
import { strippedPhotoToJpg } from 'telegram/Utils'
import { LogLevel } from 'telegram/extensions/Logger'
import type { MTProtoSender } from 'telegram/network'
import bigInt from 'big-integer'
import { app, safeStorage } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TelegramFileSource } from '../download/telegramTransfer'
import { TelegramFileError } from '../download/telegramTransfer'
import type {
  TelegramAuthState,
  TelegramCredentials,
  TelegramMediaItem,
  TelegramMediaPage,
  TelegramMediaType
} from '../../shared/types'

/**
 * The user's Telegram session, its Saved Messages listing, and the file sources its downloads
 * fetch from. Signed in with the user's own api_id/api_hash (my.telegram.org) and a phone code
 * — a bot token can't read a user's Saved Messages — the session is used only ever against the
 * "me" peer: this module has no way to address any other chat.
 */

const STORE_PATH = (): string => join(app.getPath('userData'), 'telegram-auth.json')

/** Listing page size, and the most messages one listing request may return. */
const LIST_PAGE = 50

/** Independent connections a download may open to its file's data center, all under the one
 * login — the shape of a fast download in Telegram's own desktop client. */
const FILE_SENDER_POOL = 8

interface StoredAuth {
  /** Sealed (safeStorage) or plain JSON of TelegramCredentials. */
  credentials?: string
  /** Sealed (safeStorage) or plain GramJS session string. */
  session?: string
}

/** A message's media as a download needs it: its location, and its byte size when Telegram
 * reports one (a photo's is only known once downloaded). */
interface LocatedMedia {
  location: Api.TypeInputFileLocation
  dcId: number
  /** null when the size is unknown (a photo). */
  size: number | null
  mediaType: TelegramMediaType
  fileName: string
  mimeType: string
}

function seal(value: string): string | undefined {
  if (!safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.encryptString(value).toString('base64')
  } catch {
    return undefined
  }
}

function unseal(sealed: string): string | undefined {
  try {
    return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
  } catch {
    return undefined
  }
}

async function loadStore(): Promise<StoredAuth> {
  try {
    const parsed = JSON.parse(await readFile(STORE_PATH(), 'utf-8')) as StoredAuth
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

async function saveStore(update: StoredAuth): Promise<void> {
  await writeFile(STORE_PATH(), JSON.stringify(update), 'utf-8')
}

/** The message's media as Telegram files name themselves: the file attribute's name when there
 * is one, or by kind and message id otherwise. */
function defaultName(mediaType: TelegramMediaType, messageId: number, mimeType: string): string {
  const extension =
    {
      photo: '.jpg',
      video: '.mp4',
      audio: '.mp3',
      voice: '.ogg',
      animation: '.mp4',
      sticker: '.webp',
      document: ''
    }[mediaType] ?? ''
  const idPart = mediaType === 'document' ? 'file' : mediaType
  return mimeType === '' && extension === ''
    ? `${idPart}_${messageId}`
    : `${idPart}_${messageId}${extension}`
}

/** The message's media, classified and named, as both the listing and the downloads use it. */
function describeMedia(
  messageId: number,
  media: Api.TypeMessageMedia
):
  | (Omit<TelegramMediaItem, 'messageId' | 'date' | 'thumbnail'> & { media: Api.TypeMessageMedia })
  | null {
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = media.photo
    if (!(photo instanceof Api.Photo)) return null
    const size = photo.sizes
      .filter((entry): entry is Api.PhotoSize => entry instanceof Api.PhotoSize)
      .sort((a, b) => b.w * b.h - a.w * a.h)[0]
    return {
      type: 'photo',
      fileName: defaultName('photo', messageId, 'image/jpeg'),
      mimeType: 'image/jpeg',
      totalBytes: 0,
      width: size?.w,
      height: size?.h,
      media
    }
  }
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document
    if (!(document instanceof Api.Document)) return null
    let type: TelegramMediaType = 'document'
    let width: number | undefined
    let height: number | undefined
    let fileName = ''
    for (const attribute of document.attributes) {
      if (attribute instanceof Api.DocumentAttributeFilename) {
        fileName = attribute.fileName
      } else if (attribute instanceof Api.DocumentAttributeAnimated) {
        type = 'animation'
      } else if (attribute instanceof Api.DocumentAttributeSticker) {
        type = 'sticker'
      } else if (attribute instanceof Api.DocumentAttributeVideo) {
        type = 'video'
        width = attribute.w
        height = attribute.h
      } else if (attribute instanceof Api.DocumentAttributeAudio) {
        type = attribute.voice ? 'voice' : 'audio'
      }
    }
    return {
      type,
      fileName: fileName || defaultName(type, messageId, document.mimeType),
      mimeType: document.mimeType,
      totalBytes: Number(document.size),
      width,
      height,
      media
    }
  }
  // Web previews, contacts, maps and the rest aren't downloadable media.
  return null
}

/** The tiny inline thumbnail Telegram carries in the message itself — no download, decoded by
 * GramJS into a JPEG — as a data URL for the media browser. */
function thumbnailOf(media: Api.TypeMessageMedia): string | undefined {
  let stripped: Buffer | undefined
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = media.photo
    if (photo instanceof Api.Photo) {
      stripped = photo.sizes.find(
        (entry): entry is Api.PhotoStrippedSize => entry instanceof Api.PhotoStrippedSize
      )?.bytes
    }
  } else if (media instanceof Api.MessageMediaDocument) {
    const document = media.document
    if (document instanceof Api.Document) {
      stripped = document.thumbs?.find(
        (entry): entry is Api.PhotoStrippedSize => entry instanceof Api.PhotoStrippedSize
      )?.bytes
    }
  }
  if (!stripped || stripped.length === 0) return undefined
  try {
    const jpeg = strippedPhotoToJpg(stripped)
    return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : undefined
  } catch {
    return undefined
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs `promise` against `signal`: rejects as soon as the signal aborts, even though the
 * request underneath keeps going (its answer is then discarded). */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new TelegramFileError('other', 'Aborted'))
      void promise.catch(() => {})
      return
    }
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new TelegramFileError('other', 'Aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** The failures of a getFile request, as kinds the transfer acts on. */
function asFileError(error: unknown): TelegramFileError {
  if (error instanceof FloodWaitError) {
    return new TelegramFileError(
      'rate',
      `Telegram rate limit: wait ${error.seconds}s`,
      error.seconds
    )
  }
  const message = describeError(error)
  const code = (error as { errorMessage?: string } | null)?.errorMessage ?? message
  if (
    /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED|SESSION_EXPIRED/.test(
      code
    )
  ) {
    return new TelegramFileError('auth', 'This Telegram session signed out. Sign in again.')
  }
  if (/LOCATION_INVALID|FILE_ID_INVALID|FILE_INVALID|ENTITY_EMPTY|MESSAGE_ID_INVALID/.test(code)) {
    return new TelegramFileError('missing', "That message's media is gone from Saved Messages.")
  }
  if (
    /TIMEOUT|TIMEOUT_NOT_ENOUGHT| disconnect|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE/.test(code)
  ) {
    return new TelegramFileError('network', 'The connection to Telegram dropped.')
  }
  return new TelegramFileError('other', message)
}

const isFileReferenceError = (error: unknown): boolean =>
  /FILE_REFERENCE/.test((error as { errorMessage?: string } | null)?.errorMessage ?? '')

export class TelegramService {
  private client?: TelegramClient
  private credentials?: TelegramCredentials
  private phoneCodeHash?: string
  private auth: TelegramAuthState = {
    signedIn: false,
    awaitingCode: false,
    awaitingPassword: false
  }
  /** Set by registerIpcHandlers: pushes state changes to the window. */
  onChange: ((state: TelegramAuthState) => void) | undefined

  authState(): TelegramAuthState {
    return structuredClone(this.auth)
  }

  /** Reads the stored credentials and session and, if there is one, reconnects in the
   * background — its answer (signed in, or the session was revoked) pushes when it lands. */
  async restore(): Promise<void> {
    const stored = await loadStore()
    const credentials = stored.credentials
      ? (JSON.parse(unseal(stored.credentials) ?? 'null') as TelegramCredentials | null)
      : null
    if (!credentials?.apiId || !credentials.apiHash) return
    this.credentials = credentials
    this.auth = {
      signedIn: false,
      awaitingCode: false,
      awaitingPassword: false,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      phone: credentials.phone
    }
    if (!stored.session) {
      this.onChange?.(this.authState())
      return
    }
    try {
      await this.openWithSession(unseal(stored.session) ?? '')
      const me = await this.client!.getMe()
      this.auth = {
        ...this.auth,
        signedIn: true,
        userName: userNameOf(me)
      }
    } catch {
      // A dead session is a sign-in prompt, not an error.
      this.client = undefined
    }
    this.onChange?.(this.authState())
  }

  private async openWithSession(session: string): Promise<TelegramClient> {
    if (!this.credentials) throw new Error('Telegram credentials are missing.')
    const client = new TelegramClient(
      new StringSession(session),
      this.credentials.apiId,
      this.credentials.apiHash,
      {
        connectionRetries: 3,
        autoReconnect: true
      }
    )
    client.setLogLevel(LogLevel.ERROR)
    await client.connect()
    this.client = client
    return client
  }

  /** Connects and sends the login code. Keeps any credentials already stored (prefilled). */
  async startLogin(credentials: TelegramCredentials): Promise<void> {
    const apiId = Math.floor(Number(credentials.apiId))
    const apiHash = credentials.apiHash.trim()
    const phone = credentials.phone.trim()
    if (!Number.isSafeInteger(apiId) || apiId <= 0)
      throw new Error('Enter the api_id from my.telegram.org.')
    if (!apiHash) throw new Error('Enter the api_hash from my.telegram.org.')
    if (!phone) throw new Error('Enter your phone number.')
    this.credentials = { apiId, apiHash, phone }
    try {
      const client = await this.openWithSession('')
      const { phoneCodeHash } = await sendCode(client, { apiId, apiHash }, phone)
      this.phoneCodeHash = phoneCodeHash
      this.auth = {
        signedIn: false,
        awaitingCode: true,
        awaitingPassword: false,
        apiId,
        apiHash,
        phone
      }
      this.onChange?.(this.authState())
    } catch (error) {
      this.auth = {
        ...this.auth,
        awaitingCode: false,
        awaitingPassword: false,
        error: describeError(error)
      }
      this.onChange?.(this.authState())
      throw error
    }
  }

  /** Accepts the login code. Wrong codes keep the dialog asking; a password requirement moves
   * it on to the password. */
  async submitCode(code: string): Promise<void> {
    const client = this.client
    if (!client || !this.credentials || !this.phoneCodeHash) {
      throw new Error('Start the sign-in again: the code was sent too long ago.')
    }
    try {
      const result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: this.credentials.phone,
          phoneCodeHash: this.phoneCodeHash,
          phoneCode: code.trim()
        })
      )
      await this.completeSignIn(client)
      void result
    } catch (error) {
      if (/SESSION_PASSWORD_NEEDED/.test((error as { errorMessage?: string }).errorMessage ?? '')) {
        this.auth = { ...this.auth, awaitingCode: false, awaitingPassword: true, error: undefined }
        this.onChange?.(this.authState())
        return
      }
      this.auth = { ...this.auth, error: describeError(error) }
      this.onChange?.(this.authState())
      return
    }
  }

  /** Accepts the two-step-verification password. */
  async submitPassword(password: string): Promise<void> {
    const client = this.client
    if (!client) throw new Error('Start the sign-in again.')
    try {
      const pwdInfo = await client.invoke(new Api.account.GetPassword())
      const srp = await computeCheck(pwdInfo, password)
      await client.invoke(new Api.auth.CheckPassword({ password: srp }))
      await this.completeSignIn(client)
    } catch (error) {
      this.auth = { ...this.auth, error: describeError(error) }
      this.onChange?.(this.authState())
    }
  }

  private async completeSignIn(client: TelegramClient): Promise<void> {
    // The session is the StringSession this client was built with; its base class types save()
    // as void.
    const session = (client.session as StringSession).save()
    const credentials = this.credentials!
    let userName: string | undefined
    try {
      userName = userNameOf(await client.getMe())
    } catch {
      // The name is display-only.
    }
    this.auth = {
      signedIn: true,
      awaitingCode: false,
      awaitingPassword: false,
      apiId: credentials.apiId,
      apiHash: credentials.apiHash,
      phone: credentials.phone,
      userName,
      error: undefined
    }
    await saveStore({
      credentials: seal(JSON.stringify(credentials)),
      session: seal(session)
    })
    this.onChange?.(this.authState())
  }

  /** Signs out and forgets everything stored. Downloads under way fail with "signed out". */
  async logout(): Promise<void> {
    try {
      await this.client?.invoke(new Api.auth.LogOut())
    } catch {
      // Logging out server-side is best-effort; the local session goes regardless.
    }
    try {
      await this.client?.disconnect()
    } catch {
      // Same.
    }
    this.client = undefined
    this.phoneCodeHash = undefined
    this.auth = { signedIn: false, awaitingCode: false, awaitingPassword: false }
    await rm(STORE_PATH(), { force: true }).catch(() => {})
    this.onChange?.(this.authState())
  }

  /** The signed-in client, connecting if this is the first use this launch. */
  private async ready(): Promise<TelegramClient> {
    if (!this.client) {
      const stored = await loadStore()
      const session = stored.session ? (unseal(stored.session) ?? '') : ''
      if (!session || !this.credentials) throw new Error('Sign in to Telegram first.')
      await this.openWithSession(session)
    }
    return this.client!
  }

  /** One page of Saved Messages media, newest first; `offsetId` asks for older ones. */
  async listMediaPage(offsetId?: number, limit?: number): Promise<TelegramMediaPage> {
    const client = await this.ready()
    const count = Math.min(Math.max(limit ?? LIST_PAGE, 1), 100)
    const messages = await client.getMessages('me', {
      limit: count,
      ...(offsetId !== undefined ? { offsetId } : {})
    })
    const items: TelegramMediaItem[] = []
    for (const message of messages) {
      if (!message.media) continue
      const described = describeMedia(message.id, message.media)
      if (!described) continue
      const { media, ...item } = described
      items.push({
        ...item,
        messageId: message.id,
        date: message.date ?? 0,
        thumbnail: thumbnailOf(media)
      })
    }
    const exhausted = messages.length < count
    const oldest = messages.at(-1)?.id
    return {
      items,
      nextOffsetId: !exhausted && oldest !== undefined ? oldest : undefined,
      exhausted
    }
  }

  /** A message's media, classified and sized, as starting a download of it needs. */
  private async locate(messageId: number): Promise<LocatedMedia> {
    const client = await this.ready()
    const [message] = await client.getMessages('me', { ids: [messageId] })
    if (!message?.media) {
      throw new Error("That message's media is gone from Saved Messages.")
    }
    const described = describeMedia(message.id, message.media)
    if (!described) throw new Error("That message's media isn't downloadable.")
    if (described.type === 'photo' && described.media instanceof Api.MessageMediaPhoto) {
      const photo = described.media.photo
      if (photo instanceof Api.Photo) {
        const largest = photo.sizes
          .filter((entry): entry is Api.PhotoSize => entry instanceof Api.PhotoSize)
          .sort((a, b) => b.w * b.h - a.w * a.h)[0]
        return {
          location: new Api.InputPhotoFileLocation({
            id: photo.id,
            accessHash: photo.accessHash,
            fileReference: photo.fileReference,
            thumbSize: largest?.type ?? ''
          }),
          dcId: photo.dcId,
          size: null,
          mediaType: 'photo',
          fileName: described.fileName,
          mimeType: described.mimeType
        }
      }
    } else if (described.media instanceof Api.MessageMediaDocument) {
      const document = described.media.document
      if (document instanceof Api.Document) {
        return {
          location: new Api.InputDocumentFileLocation({
            id: document.id,
            accessHash: document.accessHash,
            fileReference: document.fileReference,
            thumbSize: ''
          }),
          dcId: document.dcId,
          size: Number(document.size),
          mediaType: described.type,
          fileName: described.fileName,
          mimeType: described.mimeType
        }
      }
    }
    throw new Error("That message's media isn't downloadable.")
  }

  /** What starting a download shows before it begins: its name and size. */
  async mediaInfo(messageId: number): Promise<{
    fileName: string
    totalBytes: number
    mimeType: string
    mediaType: TelegramMediaType
  }> {
    const located = await this.locate(messageId)
    return {
      fileName: located.fileName,
      totalBytes: located.size ?? 0,
      mimeType: located.mimeType,
      mediaType: located.mediaType
    }
  }

  /** The bytes of one media file, for a download's transfer. The location is looked up lazily
   * (on the first request), and refetched when Telegram says its reference went stale — which
   * it does within a day, so a paused download's resume rebuilds it rather than failing.
   *
   * Chunks rotate across a small pool of independent connections to the file's data center,
   * all under this one login — the shape of a fast download in Telegram's own desktop client.
   * The connections this source opened are closed when the download is done with it. */
  async fileSource(messageId: number): Promise<TelegramFileSource> {
    const client = await this.ready()
    let located: LocatedMedia | null = null
    const locateNow = async (): Promise<LocatedMedia> => {
      try {
        return await this.locate(messageId)
      } catch (error) {
        throw new TelegramFileError('missing', describeError(error))
      }
    }

    // One entry per connection: `owned` marks the ones dispose() may close (a GramJS-borrowed
    // fallback is the client's own shared sender, which must outlive this download), and
    // `load` is its requests in flight — chunks go to the least-loaded connection.
    interface Connection {
      sender: MTProtoSender
      owned: boolean
      load: number
    }
    const pool: Connection[] = []
    let sourceDisposed = false

    const disposePool = async (): Promise<void> => {
      const entries = pool.splice(0, pool.length)
      for (const entry of entries) {
        if (!entry.owned) continue
        await entry.sender.disconnect().catch(() => {})
      }
    }

    const requestChunk = async (
      offset: number,
      limit: number,
      guard: AbortSignal
    ): Promise<Buffer> => {
      // A connection with nothing in flight takes the chunk without an await in between, so
      // simultaneous readers spread out instead of piling onto the same one.
      let entry: Connection | undefined
      for (const candidate of pool) {
        if (candidate.load === 0) {
          entry = candidate
          break
        }
        if (!entry || candidate.load < entry.load) entry = candidate
      }
      if (!entry || (entry.load >= 1 && pool.length < FILE_SENDER_POOL)) {
        const created = await this.createSender(located!.dcId)
        entry = { sender: created.sender, owned: created.owned, load: 0 }
        pool.push(entry)
      }
      entry.load += 1
      try {
        const request = client.invokeWithSender(
          new Api.upload.GetFile({
            location: located!.location,
            offset: bigInt(offset),
            limit
          }),
          entry.sender
        )
        const result = await raceSignal(request, guard)
        if (result instanceof Api.upload.FileCdnRedirect) {
          throw new TelegramFileError(
            'other',
            'Telegram served this file from a CDN, which Plexo can’t fetch.'
          )
        }
        return result.bytes
      } catch (error) {
        // A connection that hung until the guard's timeout is dropped: the next acquire
        // builds a fresh one. (The reader's own abort leaves it be — the run is ending.)
        if (guard.reason?.name === 'TimeoutError') {
          const at = pool.indexOf(entry)
          if (at >= 0) pool.splice(at, 1)
          if (entry.owned) void entry.sender.disconnect().catch(() => {})
        }
        throw error
      } finally {
        entry.load -= 1
      }
    }

    return {
      get unknownSize(): boolean {
        return located?.size === null
      },
      dispose: async (): Promise<void> => {
        sourceDisposed = true
        await disposePool()
      },
      async request(offset: number, limit: number, signal: AbortSignal): Promise<Buffer> {
        if (sourceDisposed) {
          throw new TelegramFileError('other', 'This download was stopped.')
        }
        if (!located) located = await locateNow()
        // A hung connection must not hold a reader past half a minute; the transfer retries
        // on this connection if it recovers, or the pool replaces it if it doesn't.
        const guard = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        try {
          return await requestChunk(offset, limit, guard)
        } catch (error) {
          if (error instanceof TelegramFileError || signal.aborted) throw error
          if (isFileReferenceError(error)) {
            // The reference went stale: refetch the message and try the same chunk once more.
            located = await locateNow()
            return await requestChunk(offset, limit, guard)
          }
          if (error instanceof FileMigrateError) {
            // The connections target the wrong DC now: drop them and follow the file.
            await disposePool()
            located = { ...located!, dcId: error.newDc }
            return await requestChunk(offset, limit, guard)
          }
          throw asFileError(error)
        }
      }
    }
  }

  /** One fresh connection to `dcId` under this login: a GramJS exported sender, connected and
   * authorized explicitly. The client's own connect helper is deliberately not used — it
   * writes the authorization handshake into a shared init object, so several connections
   * created at once clobber each other's handshake (AUTH_BYTES_INVALID). Falls back to the
   * client's shared pooled sender when any of this fails. */
  private async createSender(dcId: number): Promise<{ sender: MTProtoSender; owned: boolean }> {
    const client = await this.ready()
    const internals = client as unknown as {
      _createExportedSender(dcId: number): MTProtoSender
      _connection: new (options: {
        ip: string
        port: number
        dcId: number
        loggers: unknown
        proxy: unknown
        testServers: unknown
        socket: unknown
      }) => Parameters<MTProtoSender['connect']>[0]
      _proxy: unknown
      _log: unknown
      testServers: unknown
      networkSocket: unknown
      _initRequest: Api.InvokeWithLayer
      getSender(dcId: number): Promise<MTProtoSender>
    }
    let sender: MTProtoSender | undefined
    try {
      sender = internals._createExportedSender(dcId)
      // The data center's address; an existing key for it says to ask the -1 test DC list
      // instead, as the client's own connect helper does.
      const hasKey = !!sender.authKey?.getKey()
      const dc = await client.getDC(dcId, hasKey)
      const connection = new internals._connection({
        ip: dc.ipAddress,
        port: dc.port,
        dcId,
        loggers: internals._log,
        proxy: internals._proxy,
        testServers: internals.testServers,
        socket: internals.networkSocket
      })
      // A connection attempt that hangs (an unreachable DC) must not hold the download; the
      // loser of the race is disconnected and the client's shared sender carries on instead.
      const connecting = (async (): Promise<void> => {
        await sender!.connect(connection, false)
        // Another data center needs this login's authorization exported to it — per sender,
        // with the client's own identity copied in rather than its shared init object.
        if ((client.session.dcId ?? 0) !== dcId) {
          const auth = await client.invoke(new Api.auth.ExportAuthorization({ dcId }))
          const identity =
            internals._initRequest.query instanceof Api.InitConnection
              ? internals._initRequest.query
              : undefined
          await sender!.send(
            new Api.InvokeWithLayer({
              layer: LAYER,
              query: new Api.InitConnection({
                apiId: identity?.apiId ?? this.credentials!.apiId,
                deviceModel: identity?.deviceModel ?? 'Desktop',
                systemVersion: identity?.systemVersion ?? 'unknown',
                appVersion: identity?.appVersion ?? 'Plexo',
                systemLangCode: identity?.systemLangCode ?? 'en',
                langPack: identity?.langPack ?? '',
                langCode: identity?.langCode ?? 'en',
                query: new Api.auth.ImportAuthorization({ id: auth.id, bytes: auth.bytes })
              })
            })
          )
        }
        ;(sender as unknown as { dcId: number }).dcId = dcId
      })()
      void connecting.catch(() => {})
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out connecting to Telegram')),
          15_000
        )
        timer.unref()
        connecting.then(
          () => {
            clearTimeout(timer)
            resolve()
          },
          (cause: unknown) => {
            clearTimeout(timer)
            reject(cause)
          }
        )
      })
      return { sender, owned: true }
    } catch {
      if (sender) void sender.disconnect().catch(() => {})
      try {
        return { sender: await internals.getSender(dcId), owned: false }
      } catch (cause) {
        throw new TelegramFileError('network', describeError(cause))
      }
    }
  }
}

function userNameOf(user: Api.TypeUser): string | undefined {
  if (user instanceof Api.User) {
    return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || undefined
  }
  return undefined
}
