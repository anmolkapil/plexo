import { parseSocks5Line } from '@shared/socks5'
import { MAX_SOCKS5_HOSTS, type Socks5Host, type Socks5Settings } from '@shared/types'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useSocks5Store } from '../store/useSocks5Store'
import { describeError } from '../utils/format'
import { Alert, AlertDescription } from './ui/alert'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Switch } from './ui/switch'
import { Textarea } from './ui/textarea'

const hintClass = 'text-[12.5px] leading-snug text-[var(--text-secondary)]'
const fieldLabelClass =
  'font-mono text-[9px] leading-none font-medium tracking-[0.12em] text-muted-foreground uppercase'

function newHost(partial: Partial<Socks5Host> = {}): Socks5Host {
  return { id: crypto.randomUUID(), enabled: true, host: '', port: 1080, ...partial }
}

/** The text of a port field is kept as typed, so it can be empty while it's being edited. */
type Row = Socks5Host & { portText: string }

const toRow = (host: Socks5Host): Row => ({ ...host, portText: String(host.port) })

function rowProblem(row: Row): string | null {
  if (!row.host.trim()) return 'Enter an address'
  const port = Number(row.portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'Port must be 1–65535'
  return null
}

function Socks5Editor({ onClose }: { onClose: () => void }): React.JSX.Element {
  const saved = useSocks5Store.getState().settings
  const [enabled, setEnabled] = useState(saved.enabled)
  const [rows, setRows] = useState<Row[]>(() => saved.hosts.map(toRow))
  const [pasting, setPasting] = useState(false)
  const [pasted, setPasted] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (id: string, patch: Partial<Row>): void =>
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  const addPasted = (): void => {
    const lines = pasted
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
    const parsed = lines.map(parseSocks5Line)
    const added = parsed.filter((host) => host !== null).map((host) => toRow(newHost(host)))
    const skipped = parsed.length - added.length
    setRows((previous) => [...previous, ...added].slice(0, MAX_SOCKS5_HOSTS))
    setPasted(skipped > 0 ? lines.filter((_, i) => parsed[i] === null).join('\n') : '')
    setPasting(skipped > 0)
    setError(
      skipped > 0
        ? `${skipped} line${skipped === 1 ? '' : 's'} couldn’t be read, left below.`
        : null
    )
  }

  const problems = rows.map(rowProblem)
  const hasProblem = problems.some((problem) => problem !== null)
  const usable = rows.filter((row) => row.enabled).length
  const blocked = enabled && usable === 0

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const settings: Socks5Settings = {
      enabled,
      hosts: rows.map(({ portText, username, password, ...host }) => ({
        ...host,
        host: host.host.trim(),
        port: Number(portText),
        username: username?.trim() || undefined,
        password: password || undefined
      }))
    }
    try {
      await useSocks5Store.getState().save(settings)
      onClose()
    } catch (cause) {
      setError(describeError(cause))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="flex items-center justify-between border-b-[0.5px] border-border px-4 py-3">
        <DialogTitle className="text-[16px] font-semibold">SOCKS5 proxies</DialogTitle>
        <label className="flex items-center gap-2 text-[13px]">
          {enabled ? 'On' : 'Off'}
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Use SOCKS5 proxies" />
        </label>
      </div>

      <fieldset disabled={saving} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className={hintClass}>
          While on, every download connection goes through one of the enabled servers below.
          Connections are shared out evenly between them, within each network too, and a server that
          stops answering is skipped for a while. A network with a proxy of its own keeps it. If
          every server is down, downloads wait rather than connect directly. Torrents don’t use
          these.
        </p>

        <div className="mt-3 flex flex-col gap-2">
          {rows.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[13px] text-muted-foreground">
              No servers yet. Add one, or paste a list.
            </div>
          )}
          {rows.map((row, index) => {
            const problem = problems[index]
            return (
              <div
                key={row.id}
                className="grid grid-cols-[auto_1fr_72px_1fr_1fr_auto] items-end gap-2 rounded-lg border border-border p-2"
              >
                <Switch
                  checked={row.enabled}
                  onCheckedChange={(checked) => update(row.id, { enabled: checked })}
                  aria-label={`Use server ${index + 1}`}
                  className="mb-0.5"
                />
                <label className="flex flex-col gap-1">
                  <span className={fieldLabelClass}>Host / IP</span>
                  <Input
                    value={row.host}
                    onChange={(event) => update(row.id, { host: event.target.value })}
                    placeholder="127.0.0.1"
                    aria-invalid={problem !== null && !row.host.trim()}
                    className="font-mono text-[12px]"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabelClass}>Port</span>
                  <Input
                    inputMode="numeric"
                    value={row.portText}
                    onChange={(event) => update(row.id, { portText: event.target.value })}
                    aria-invalid={problem === 'Port must be 1–65535'}
                    className="font-mono text-[12px]"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabelClass}>User (opt)</span>
                  <Input
                    value={row.username ?? ''}
                    onChange={(event) => update(row.id, { username: event.target.value })}
                    autoComplete="off"
                    className="text-[12px]"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className={fieldLabelClass}>Password (opt)</span>
                  <Input
                    type="password"
                    value={row.password ?? ''}
                    onChange={(event) => update(row.id, { password: event.target.value })}
                    autoComplete="off"
                    className="text-[12px]"
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove server ${index + 1}`}
                  onClick={() => setRows((previous) => previous.filter((r) => r.id !== row.id))}
                >
                  <Trash2 />
                </Button>
                {problem && (
                  <div className="col-span-full text-[11.5px] text-destructive">{problem}</div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={rows.length >= MAX_SOCKS5_HOSTS}
            onClick={() => setRows((previous) => [...previous, toRow(newHost())])}
          >
            <Plus /> Add server
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setPasting(!pasting)}>
            {pasting ? 'Hide list' : 'Paste a list'}
          </Button>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">
            {usable} of {rows.length} in use
          </span>
        </div>

        {pasting && (
          <div className="mt-2 flex flex-col gap-2">
            <Textarea
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder={
                'One per line:\n1.2.3.4:1080\nuser:pass@5.6.7.8:1080\nsocks5://9.9.9.9:9050'
              }
              className="min-h-24 font-mono text-[12px]"
            />
            <div>
              <Button type="button" size="sm" disabled={!pasted.trim()} onClick={addPasted}>
                Add these
              </Button>
            </div>
          </div>
        )}
      </fieldset>

      {(error || blocked) && (
        <div className="px-4 pb-2">
          <Alert variant="destructive">
            <AlertDescription>
              {error ?? 'Turn on at least one server, or switch SOCKS5 off.'}
            </AlertDescription>
          </Alert>
        </div>
      )}
      <div className="flex items-center justify-end gap-2 border-t-[0.5px] border-border px-4 py-2">
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={saving || hasProblem || blocked}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}

/** The SOCKS5 pool's servers and its switch. Nothing changes until Save. */
export function Socks5Dialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(560px,calc(100%-2rem))] max-w-[760px] flex-col gap-0 p-0 sm:max-w-[760px]"
      >
        {/* Mounted only while open, so each opening starts a fresh draft. */}
        <Socks5Editor onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}
