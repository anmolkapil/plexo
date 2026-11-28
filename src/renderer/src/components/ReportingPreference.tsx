import {
  Check,
  Coffee,
  FolderTree,
  HardDrive,
  Heart,
  ListOrdered,
  MessageCircle,
  Minimize2,
  Send,
  Server,
  Star,
  X
} from 'lucide-react'
import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Switch } from './ui/switch'

const REPORT_CONTENTS = [
  { sent: true, text: 'App version and system' },
  { sent: true, text: 'What went wrong' },
  { sent: false, text: 'Your links, files or downloads' },
  { sent: false, text: 'Your networks or passwords' }
]

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
        Send crash reports
        <Switch
          checked={!forcedOff && checked}
          disabled={forcedOff || disabled}
          onCheckedChange={change}
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {forcedOff
          ? 'Your DO_NOT_TRACK setting has turned crash reports off.'
          : availability === 'unconfigured'
            ? 'Sentry isn’t set up in this build. Set SENTRY_DSN when packaging Plexo to send reports.'
            : 'If something goes wrong, Plexo can send a short report so it can be fixed. Your links, files and networks always stay private.'}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">What’s sent</summary>
        <ul className="mt-2 grid gap-1">
          {REPORT_CONTENTS.map(({ sent, text }) => (
            <li key={text} className="flex items-center gap-2">
              {sent ? (
                <Check aria-label="Sent" className="size-4 text-muted-foreground" />
              ) : (
                <X aria-label="Never sent" className="size-4 text-muted-foreground" />
              )}
              {text}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-muted-foreground">
          Reports go to Sentry. Plexo asks it not to keep your IP address.
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
      {error && <p role="alert">Couldn’t save this preference. Try again.</p>}
    </div>
  )
}

const NEW_IN_1_0 = [
  {
    icon: FolderTree,
    title: 'Just the files you want',
    text: 'Pick one episode from a torrent, not the whole season.'
  },
  {
    icon: Send,
    title: 'Telegram downloads',
    text: 'Save videos and files from your Telegram Saved Messages.'
  },
  {
    icon: Server,
    title: 'Usenet support',
    text: 'Add an NZB file. Plexo fixes and unzips it for you.'
  },
  {
    icon: Minimize2,
    title: 'Runs in the background',
    text: 'Close the window and your downloads keep going.'
  },
  {
    icon: HardDrive,
    title: 'Never run out of space',
    text: 'Plexo checks you have room before it starts.'
  },
  {
    icon: ListOrdered,
    title: 'Your queue, your order',
    text: 'Move downloads up, or start one right now.'
  }
]

const SUPPORT_LINKS = [
  { icon: Star, label: 'Star on GitHub', href: 'https://github.com/anmolkapil/plexo' },
  { icon: Heart, label: 'Sponsor', href: 'https://github.com/sponsors/anmolkapil' },
  { icon: Coffee, label: 'Buy me a coffee', href: 'https://ko-fi.com/I5Q128RXSP' },
  {
    icon: MessageCircle,
    label: 'Share ideas',
    href: 'https://github.com/anmolkapil/plexo/discussions'
  }
]

const PAGE_TITLES = ['Welcome to Plexo 1.0', 'Help make Plexo better', 'Thank you ❤️']
const LAST_PAGE = PAGE_TITLES.length - 1

export function WelcomeDialog(): React.JSX.Element {
  const availability = window.plexo.initialState.reportingAvailability
  const [page, setPage] = useState(0)
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
        className="sm:max-w-xl max-h-[calc(100%-2rem)] overflow-y-auto"
      >
        <DialogTitle>{PAGE_TITLES[page]}</DialogTitle>
        {page === 0 && (
          <>
            <DialogDescription>Our biggest update yet. Here’s what’s new.</DialogDescription>
            <ul className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              {NEW_IN_1_0.map(({ icon: Icon, title, text }) => (
                <li key={title} className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="grid gap-0.5 text-sm">
                    <span className="font-medium">{title}</span>
                    <span className="text-muted-foreground">{text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              We fixed the little things that used to get in your way: 26 bugs fixed and 2 speed
              boosts.
            </p>
          </>
        )}
        {page === 1 && (
          <>
            <ReportingPreference checked={choice} disabled={saving} change={setChoice} />
            <p className="text-sm text-muted-foreground">Change this anytime in Settings.</p>
          </>
        )}
        {page === LAST_PAGE && (
          <>
            <div className="grid gap-2 text-sm">
              <p>
                Your kind words and support have been overwhelming. Thank you for making Plexo part
                of your day.
              </p>
              <p>
                Plexo will stay free forever, with no ads. If it’s made your downloads faster, a
                star or a small donation keeps me going. And I’d love to hear what you want next.
              </p>
              <p>
                Thanks to everyone who tested, shared and contributed to Plexo, and to Dhananjay
                Bhosale for signing the Mac app.
              </p>
              <p>— Anmol</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {SUPPORT_LINKS.map(({ icon: Icon, label, href }) => (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<a href={href} target="_blank" rel="noreferrer" />}
                >
                  <Icon aria-hidden />
                  {label}
                </Button>
              ))}
            </div>
          </>
        )}
        {error && <p role="alert">Couldn’t save your choice. Try again.</p>}
        <DialogFooter className="items-center">
          <span
            className="mr-auto flex gap-1.5"
            aria-label={`Page ${page + 1} of ${LAST_PAGE + 1}`}
          >
            {PAGE_TITLES.map((title, index) => (
              <span
                key={title}
                className={`size-1.5 rounded-full ${index === page ? 'bg-foreground' : 'bg-muted-foreground/40'}`}
              />
            ))}
          </span>
          {page > 0 && (
            <Button variant="outline" disabled={saving} onClick={() => setPage(page - 1)}>
              Back
            </Button>
          )}
          {page < LAST_PAGE ? (
            <Button onClick={() => setPage(page + 1)}>Next</Button>
          ) : (
            <Button disabled={saving} onClick={() => void finish()}>
              Start downloading
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
