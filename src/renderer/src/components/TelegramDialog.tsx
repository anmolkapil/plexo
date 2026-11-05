import type { TelegramAuthState, TelegramMediaItem, TelegramMediaType } from '@shared/types'
import { cn } from 'cn'
import {
  Clapperboard,
  File,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Music,
  RotateCw,
  Send,
  Smile,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError, formatBytes, formatWhen } from '../utils/format'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Telegram, as Plexo reaches it: the user's own session, and only Saved Messages — the "me"
 * peer every request here is hard-pinned to. Signed in, it lists the media there; a pick of it
 * starts downloads the manager runs like any other. */

export function TelegramDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.telegramOpen)
  const close = useAppStore((store) => store.closeTelegram)

  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-[560px]"
      >
        {open && <TelegramPanel onDone={close} />}
      </DialogContent>
    </Dialog>
  )
}

function TelegramPanel({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [auth, setAuth] = useState<TelegramAuthState | null>(null)

  useEffect(() => {
    let stale = false
    void window.plexo.telegramState().then((state) => {
      if (!stale) setAuth(state)
    })
    const unsubscribe = window.plexo.onTelegramAuth((state) => setAuth(state))
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b-[0.5px] border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>Telegram — Saved Messages</DialogTitle>
          <div className="flex items-center gap-1">
            {auth?.signedIn && <SignOut />}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              onClick={onDone}
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-[1.5] text-[var(--text-secondary)]">
          Plexo is an unofficial Telegram client: signing in grants it full access to your account,
          though it reads nothing but Saved Messages.
        </p>
      </div>
      {auth === null ? (
        <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
          Checking Telegram…
        </div>
      ) : auth.signedIn ? (
        <SavedMessagesBrowser onDone={onDone} />
      ) : (
        <TelegramLogin auth={auth} />
      )}
    </div>
  )
}

function SignOut(): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void window.plexo.telegramLogout().catch(() => setBusy(false))
      }}
    >
      Sign out
    </Button>
  )
}

const fieldLabelClass = 'w-24 shrink-0 text-[12.5px] text-[var(--text-secondary)]'
const errorClass = 'text-[12px] leading-[1.4] text-[var(--color-danger)]'

/** The sign-in steps, driven by what main reports: a QR to scan (default, when credentials to
 * power one exist — Plexo's own in a bundled release, else the user's from an earlier
 * sign-in), then the code or the two-step-verification password if those flows are used. */
function TelegramLogin({ auth }: { auth: TelegramAuthState }): React.JSX.Element {
  const canQr = auth.bundled === true || auth.hasOwnKeys === true
  const [mode, setMode] = useState<'qr' | 'form'>(canQr ? 'qr' : 'form')
  const [apiId, setApiId] = useState(auth.apiId ? String(auth.apiId) : '')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState(auth.phone ?? '')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Bundled builds lead with Plexo's own credentials; the user's own api keys are one toggle
  // away — the api_hash never comes prefilled (main never sends it), and stored own keys keep
  // winning while the fields stay empty (see main's startLogin).
  const [showApi, setShowApi] = useState(auth.bundled !== true)

  const run = (work: () => Promise<void>): void => {
    setBusy(true)
    void work().finally(() => setBusy(false))
  }

  const startQr = useCallback((): void => {
    // Failures arrive as state pushes from main; the dialog just shows them.
    void window.plexo.telegramStartQrLogin().catch(() => {})
  }, [])

  useEffect(() => {
    if (mode === 'qr') startQr()
  }, [mode, startQr])

  if (auth.awaitingPassword) {
    return (
      <form
        className="flex flex-col gap-3 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          run(() => window.plexo.telegramSubmitPassword(password))
        }}
      >
        <p className="text-[12.5px] leading-[1.5]">
          Your account has two-step verification. Enter its password.
        </p>
        <div className="flex items-center gap-3">
          <label htmlFor="tg-password" className={fieldLabelClass}>
            Password
          </label>
          <Input
            id="tg-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
        </div>
        {auth.error && (
          <p role="alert" className={errorClass}>
            {auth.error}
          </p>
        )}
        <Button type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    )
  }

  if (auth.awaitingCode) {
    return (
      <form
        className="flex flex-col gap-3 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault()
          run(() => window.plexo.telegramSubmitCode(code))
        }}
      >
        <p className="text-[12.5px] leading-[1.5]">
          Telegram sent a code to <span className="font-medium">{auth.phone}</span>. Enter it here.
        </p>
        <div className="flex items-center gap-3">
          <label htmlFor="tg-code" className={fieldLabelClass}>
            Code
          </label>
          <Input
            id="tg-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoFocus
          />
        </div>
        {auth.error && (
          <p role="alert" className={errorClass}>
            {auth.error}
          </p>
        )}
        <Button type="submit" disabled={busy || code.trim().length === 0}>
          {busy ? 'Checking…' : 'Continue'}
        </Button>
      </form>
    )
  }

  if (mode === 'qr') {
    return (
      <div className="flex flex-col items-center gap-3 px-5 py-4">
        {auth.qrDataUrl ? (
          <img
            src={auth.qrDataUrl}
            alt="Telegram login QR code"
            className="size-[232px] rounded-lg border-[0.5px] border-border bg-white p-1"
          />
        ) : (
          <div
            aria-live="polite"
            className="flex size-[232px] items-center justify-center rounded-lg border-[0.5px] border-border font-mono text-[11.5px] text-muted-foreground"
          >
            {auth.error ? '—' : 'Preparing QR…'}
          </div>
        )}
        <p className="text-center text-[12.5px] leading-[1.5]">
          Open Telegram on your phone →{' '}
          <span className="font-medium">Settings → Devices → Link Desktop Device</span>, and scan
          this. The code refreshes itself until scanned.
        </p>
        {auth.error && (
          <>
            <p role="alert" className={cn('text-center', errorClass)}>
              {auth.error}
            </p>
            <Button type="button" variant="outline" size="xs" onClick={startQr}>
              Retry
            </Button>
          </>
        )}
        {!auth.error && (
          <p aria-live="polite" className="font-mono text-[11px] text-muted-foreground">
            Waiting for scan…
          </p>
        )}
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode('form')}>
          Sign in with a phone number instead
        </Button>
      </div>
    )
  }

  const needsApiFields = showApi
  return (
    <form
      className="flex flex-col gap-3 px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault()
        run(() =>
          window.plexo.telegramStartLogin({
            apiId: Number(apiId),
            apiHash,
            phone
          })
        )
      }}
    >
      {needsApiFields ? (
        <p className="text-[12.5px] leading-[1.5]">
          Plexo needs an <span className="font-medium">api_id</span> and{' '}
          <span className="font-medium">api_hash</span> of your own: create an app at
          my.telegram.org → API development tools, and enter them here with your phone number.
        </p>
      ) : (
        <p className="text-[12.5px] leading-[1.5]">
          Enter your phone number and Telegram will send a login code.
        </p>
      )}
      {needsApiFields && (
        <>
          <div className="flex items-center gap-3">
            <label htmlFor="tg-api-id" className={fieldLabelClass}>
              api_id
            </label>
            <Input
              id="tg-api-id"
              value={apiId}
              onChange={(event) => setApiId(event.target.value)}
              inputMode="numeric"
              autoFocus
            />
          </div>
          <div className="flex items-center gap-3">
            <label htmlFor="tg-api-hash" className={fieldLabelClass}>
              api_hash
            </label>
            <Input
              id="tg-api-hash"
              value={apiHash}
              onChange={(event) => setApiHash(event.target.value)}
              placeholder={auth.hasOwnKeys ? 'stored — leave empty to keep it' : undefined}
            />
          </div>
        </>
      )}
      <div className="flex items-center gap-3">
        <label htmlFor="tg-phone" className={fieldLabelClass}>
          Phone
        </label>
        <Input
          id="tg-phone"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+1 555 010 1234"
          inputMode="tel"
          autoFocus={!needsApiFields}
        />
      </div>
      {(auth.bundled === true || auth.hasOwnKeys === true) && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => setShowApi((shown) => !shown)}
        >
          {showApi ? 'Use Plexo’s api keys instead' : 'Use your own api keys (advanced)'}
        </Button>
      )}
      {auth.error && (
        <p role="alert" className={errorClass}>
          {auth.error}
        </p>
      )}
      <Button type="submit" disabled={busy || !phone || (needsApiFields && (!apiId || !apiHash))}>
        {busy ? 'Sending code…' : 'Send code'}
      </Button>
      {canQr && (
        <Button type="button" variant="ghost" size="xs" onClick={() => setMode('qr')}>
          Use the QR code instead
        </Button>
      )}
    </form>
  )
}

const TYPE_ICON: Record<TelegramMediaType, React.ReactNode> = {
  photo: <ImageIcon aria-hidden className="size-4" />,
  video: <Film aria-hidden className="size-4" />,
  audio: <Music aria-hidden className="size-4" />,
  voice: <Music aria-hidden className="size-4" />,
  document: <File aria-hidden className="size-4" />,
  animation: <Clapperboard aria-hidden className="size-4" />,
  sticker: <Smile aria-hidden className="size-4" />
}

function itemSize(item: TelegramMediaItem): string {
  if (item.totalBytes > 0) return formatBytes(item.totalBytes)
  if (item.width && item.height) return `${item.width}×${item.height}`
  return 'Photo'
}

/** Saved Messages' downloadable media: pages of it, oldest page last, each row ticked to be
 * downloaded. Starting them hands each to the manager, queue and all. */
function SavedMessagesBrowser({ onDone }: { onDone: () => void }): React.JSX.Element {
  const destinationDir = useAppStore((store) => store.destinationDir)
  const setDestinationDir = useAppStore((store) => store.setDestinationDir)
  const interfaces = useAppStore((store) => store.interfaces)
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)

  const [items, setItems] = useState<TelegramMediaItem[]>([])
  const [nextOffsetId, setNextOffsetId] = useState<number | undefined>(undefined)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [starting, setStarting] = useState(false)
  const startedRef = useRef(false)
  // Read on a clock, not in render (impure), like the downloads list's "when"s.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  const loadPage = useCallback(async (olderThan?: number): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const page = await window.plexo.telegramListMedia(olderThan)
      setItems((previous) => (olderThan === undefined ? page.items : [...previous, ...page.items]))
      setNextOffsetId(page.nextOffsetId)
      setExhausted(page.exhausted)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void loadPage()
    if (interfaces.length === 0) void loadInterfaces()
  }, [loadPage, interfaces.length, loadInterfaces])

  const chooseDestination = async (): Promise<void> => {
    const dir = await window.plexo.chooseDestinationFolder(destinationDir).catch(() => null)
    if (dir) setDestinationDir(dir)
  }

  const downloadSelected = (): void => {
    if (selected.size === 0) return
    setStarting(true)
    const interfaceIds = interfaces.map((iface) => iface.id)
    const picks = items.filter((item) => selected.has(item.messageId))
    for (const item of picks) {
      window.plexo
        .startDownload({
          kind: 'telegram',
          messageId: item.messageId,
          mediaType: item.type,
          url: `telegram://saved-messages/${item.messageId}`,
          destinationDir,
          suggestedFileName: item.fileName,
          totalBytes: item.totalBytes,
          supportsRanges: true,
          interfaceIds,
          etag: null,
          lastModified: null
        })
        .catch((cause) => setError(describeError(cause)))
    }
    onDone()
  }

  const toggle = (messageId: number, on: boolean): void =>
    setSelected((previous) => {
      const next = new Set(previous)
      if (on) next.add(messageId)
      else next.delete(messageId)
      return next
    })

  const picked = items.filter((item) => selected.has(item.messageId))
  const pickedBytes = picked.reduce((sum, item) => sum + item.totalBytes, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Always visible above the scrolling list: the chat may have gained files while this
          was open, so the list can be asked for its newest page again. Ticks stay on rows
          that are still there. */}
      <div className="flex items-center justify-between px-5 pt-2">
        <span className="font-mono text-[11px] leading-none text-muted-foreground">
          {items.length > 0 && `${items.length} ${items.length === 1 ? 'item' : 'items'}`}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh"
                disabled={loading}
                onClick={() => void loadPage()}
              >
                <RotateCw aria-hidden />
              </Button>
            }
          />
          <TooltipContent>Refresh — list the newest files again</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {items.length === 0 && !loading && !error ? (
          <p className="py-8 text-center text-[12.5px] text-muted-foreground">
            No downloadable media in Saved Messages.
          </p>
        ) : (
          <div role="group" aria-label="Saved Messages media">
            {items.map((item) => (
              <label
                key={item.messageId}
                className="flex items-center gap-3 rounded-lg px-1 py-1.5"
              >
                <Checkbox
                  checked={selected.has(item.messageId)}
                  onCheckedChange={(checked) => toggle(item.messageId, checked)}
                />
                {item.thumbnail ? (
                  <img
                    src={item.thumbnail}
                    alt=""
                    className="size-9 shrink-0 rounded-md border-[0.5px] border-border object-cover"
                  />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border-[0.5px] border-border bg-secondary text-muted-foreground">
                    {TYPE_ICON[item.type]}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{item.fileName}</span>
                  <span className="block font-mono text-[11px] text-[var(--text-secondary)]">
                    {item.type} · {itemSize(item)} · {formatWhen(item.date * 1000, now)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {loading && (
          <p className="py-3 text-center font-mono text-[11px] text-muted-foreground">Loading…</p>
        )}
        {error && (
          <p role="alert" className={cn('py-2 text-center', errorClass)}>
            {error}
          </p>
        )}
        {!loading && !exhausted && nextOffsetId !== undefined && (
          <div className="flex justify-center py-2">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void loadPage(nextOffsetId)}
            >
              Load older
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t-[0.5px] border-border px-5 py-3">
        <Button type="button" variant="ghost" size="xs" onClick={() => void chooseDestination()}>
          <FolderOpen data-icon="inline-start" />
          {destinationDir.split(/[\\/]/).pop() || destinationDir}
        </Button>
        <div className="flex-1" />
        <Button type="button" disabled={starting || selected.size === 0} onClick={downloadSelected}>
          <Send data-icon="inline-start" />
          {selected.size === 0
            ? 'Download'
            : `Download ${selected.size}${pickedBytes > 0 ? ` · ${formatBytes(pickedBytes)}` : ''}`}
        </Button>
      </div>
    </div>
  )
}
