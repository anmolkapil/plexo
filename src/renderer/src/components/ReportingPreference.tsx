import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Switch } from './ui/switch'

function ReportingPreference({
  checked,
  disabled,
  change
}: {
  checked: boolean
  disabled: boolean
  change: (checked: boolean) => void
}): React.JSX.Element {
  const availability = window.plexo.initialState.reportingAvailability
  const forcedOff = availability === 'do-not-track'
  return (
    <section className="grid gap-2">
      <label className="flex items-center justify-between gap-3 font-medium">
        Send error reports to Sentry
        <Switch
          checked={!forcedOff && checked}
          disabled={forcedOff || disabled}
          onCheckedChange={change}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {forcedOff
          ? 'DO_NOT_TRACK=1 has turned reporting off.'
          : availability === 'unconfigured'
            ? 'This build has no reporting destination. Your preference will carry over to updates.'
            : 'Help the Plexo contributors diagnose crashes, failed downloads and network problems.'}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">What’s sent</summary>
        <p className="mt-2 text-muted-foreground">
          Reports include the Plexo version, operating system, processor architecture, affected
          operation and error category. Unexpected errors can include positions in Plexo’s own code.
          Links, file names and paths, network names, credentials and download contents stay
          private. Sentry receives your IP address with the connection. Plexo asks Sentry to leave
          it out of the report.
        </p>
      </details>
    </section>
  )
}

async function saveChoice(choice: boolean): Promise<void> {
  await window.plexo.updateSettings({ v1ErrorReporting: choice })
  useAppStore.setState({ v1ErrorReporting: choice })
}

export function PrivacyPage(): React.JSX.Element {
  const checked = useAppStore((s) => s.v1ErrorReporting === true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  async function change(choice: boolean): Promise<void> {
    setSaving(true)
    setError(false)
    try {
      await saveChoice(choice)
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="grid gap-3">
      <h2 className="font-semibold">Privacy</h2>
      <ReportingPreference
        checked={checked}
        disabled={saving}
        change={(choice) => void change(choice)}
      />
      <p className="text-sm text-muted-foreground">Changes to reporting apply immediately.</p>
      {error && <p role="alert">Couldn’t save this preference. Try again.</p>}
    </div>
  )
}

export function WelcomeDialog(): React.JSX.Element {
  const availability = window.plexo.initialState.reportingAvailability
  const [choice, setChoice] = useState(availability !== 'do-not-track')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  async function finish(): Promise<void> {
    setSaving(true)
    try {
      await saveChoice(choice)
    } catch {
      setError(true)
      setSaving(false)
    }
  }
  return (
    <Dialog open disablePointerDismissal>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md max-h-[calc(100%-2rem)] overflow-y-auto"
      >
        <DialogTitle>Welcome to Plexo 1.0</DialogTitle>
        <DialogDescription>
          Choose New download, paste a link and select the networks you want to use together.
        </DialogDescription>
        <p className="text-sm">
          Thanks to everyone who tested Plexo, reported issues and contributed code, and to
          Dhananjay Bhosale for signing the macOS app. To support development, you can donate on{' '}
          <a
            className="underline"
            href="https://github.com/sponsors/anmolkapil"
            target="_blank"
            rel="noreferrer"
          >
            GitHub Sponsors
          </a>{' '}
          or{' '}
          <a
            className="underline"
            href="https://ko-fi.com/I5Q128RXSP"
            target="_blank"
            rel="noreferrer"
          >
            Ko-fi
          </a>
          .
        </p>
        <ReportingPreference checked={choice} disabled={saving} change={setChoice} />
        <p className="text-sm text-muted-foreground">
          {availability === 'configured' && 'Reporting starts after you continue with it enabled. '}
          You can change your preference anytime in Settings → Privacy.
        </p>
        {error && <p role="alert">Couldn’t save your choice. Try again.</p>}
        <DialogFooter>
          <Button disabled={saving} onClick={() => void finish()}>
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
