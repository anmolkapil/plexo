import type { UsenetServer, UsenetServerInput } from '@shared/types'
import { AlertTriangle, Check, Server } from 'lucide-react'
import { useId, useState } from 'react'
import { describeError } from '../utils/format'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

const labelClass = 'w-24 shrink-0 text-[12.5px] text-[var(--text-secondary)]'
const hintClass = 'text-[12px] leading-snug text-muted-foreground'

/** The news server NZB downloads come from: where it is, the account, and how many connections
 * the account allows. Set once, for every NZB; the password never comes back to the window. */
export function UsenetServerDialog({
  open,
  server,
  onOpenChange,
  onSaved
}: {
  open: boolean
  /** As saved; null when there's none yet. */
  server: UsenetServer | null
  onOpenChange: (open: boolean) => void
  onSaved: (server: UsenetServer) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="flex flex-col gap-0 p-0 sm:max-w-[460px]">
        {/* Mounted only while open, so each opening starts from what's saved. */}
        {open && (
          <UsenetServerForm
            server={server}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved) => {
              onSaved(saved)
              onOpenChange(false)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** An NZB download's news server, by name, opening its settings: where a wrong password is put
 * right without an NZB to hand. */
export function UsenetServerButton({ host }: { host: string }): React.JSX.Element {
  const [server, setServer] = useState<UsenetServer | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        aria-label={`Usenet server ${host}: change settings`}
        onClick={() => {
          void window.plexo
            .usenetServer()
            .then(setServer)
            .catch(() => setServer(null))
            .finally(() => setOpen(true))
        }}
        className="h-auto cursor-default gap-1 rounded-[4px] border-[0.5px] bg-card px-[7px] py-[3px] font-mono text-[10.5px] leading-none font-medium text-[var(--text-secondary)] dark:bg-card"
      >
        <Server aria-hidden className="size-3" />
        {host}
      </Button>
      <UsenetServerDialog open={open} server={server} onOpenChange={setOpen} onSaved={setServer} />
    </>
  )
}

function UsenetServerForm({
  server,
  onCancel,
  onSaved
}: {
  server: UsenetServer | null
  onCancel: () => void
  onSaved: (server: UsenetServer) => void
}): React.JSX.Element {
  const id = useId()
  const [host, setHost] = useState(server?.host ?? '')
  const [tls, setTls] = useState(server?.tls ?? true)
  const [port, setPort] = useState(String(server?.port ?? 563))
  const [username, setUsername] = useState(server?.username ?? '')
  // Left empty, the saved password stays.
  const [password, setPassword] = useState('')
  const [connections, setConnections] = useState(String(server?.connections ?? 8))
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const input = (): UsenetServerInput => ({
    host: host.trim(),
    port: Number(port),
    tls,
    username: username.trim(),
    connections: Number(connections),
    password: password === '' && server?.hasPassword ? undefined : password
  })
  const valid =
    host.trim() !== '' &&
    Number.isInteger(Number(port)) &&
    Number(port) > 0 &&
    Number(port) < 65536 &&
    Number.isInteger(Number(connections)) &&
    Number(connections) >= 1

  const test = async (): Promise<void> => {
    setBusy('test')
    setResult(null)
    try {
      await window.plexo.testUsenetServer(input())
      setResult({ ok: true, text: 'Connected and signed in.' })
    } catch (error) {
      setResult({ ok: false, text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setResult(null)
    try {
      onSaved(await window.plexo.saveUsenetServer(input()))
    } catch (error) {
      setResult({ ok: false, text: describeError(error) })
      setBusy(null)
    }
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        // Opened from another form (New download): its submit is not this one's.
        event.stopPropagation()
        if (valid && !busy) void save()
      }}
    >
      <div className="border-b-[0.5px] border-border px-5 py-4">
        <DialogTitle className="text-[16px] font-semibold">Usenet server</DialogTitle>
        <p className={`${hintClass} mt-1.5`}>
          The news server your NZB downloads come from, as your Usenet provider gives it.
        </p>
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-3">
          <label htmlFor={`${id}-host`} className={labelClass}>
            Server
          </label>
          <Input
            id={`${id}-host`}
            autoFocus
            value={host}
            onChange={(event) => setHost(event.target.value)}
            placeholder="news.example.com"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor={`${id}-port`} className={labelClass}>
            Port
          </label>
          <Input
            id={`${id}-port`}
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            className="w-24 font-mono"
          />
          <label className="ml-auto flex items-center gap-2 text-[13px]">
            SSL
            <Switch
              checked={tls}
              onCheckedChange={(on) => {
                setTls(on)
                // The usual ports go with it; one set by hand stays.
                if (port === (on ? '119' : '563')) setPort(on ? '563' : '119')
              }}
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor={`${id}-username`} className={labelClass}>
            Username
          </label>
          <Input
            id={`${id}-username`}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor={`${id}-password`} className={labelClass}>
            Password
          </label>
          <Input
            id={`${id}-password`}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={server?.hasPassword ? 'Saved' : ''}
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-3">
          <label htmlFor={`${id}-connections`} className={labelClass}>
            Connections
          </label>
          <Input
            id={`${id}-connections`}
            inputMode="numeric"
            value={connections}
            onChange={(event) => setConnections(event.target.value.replace(/\D/g, ''))}
            className="w-24 font-mono"
          />
          <span className={hintClass}>
            What your account allows, shared by every network a download uses.
          </span>
        </div>
        {server?.passwordInMemory && (
          <p className={hintClass}>
            This computer has no keychain Plexo can use, so your password is kept only until Plexo
            quits.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 border-t-[0.5px] border-border px-4 py-2">
        <div
          role="status"
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] ${result?.ok ? 'text-[var(--color-wifi-text)]' : 'text-[var(--color-danger)]'}`}
        >
          {result &&
            (result.ok ? (
              <Check aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            ))}
          <span className="truncate" title={result?.text}>
            {result?.text}
          </span>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!valid || busy !== null}
          onClick={() => void test()}
        >
          {busy === 'test' ? 'Testing' : 'Test'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || busy !== null}>
          Save
        </Button>
      </div>
    </form>
  )
}
