import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ListPlus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { describeError } from '../utils/format'
import { parseLinks } from '../utils/links'
import { QueueDestination } from './QueueDestination'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'

/** Pasting many links at once: they join the queue, to download one after another. */
export function AddLinksDialog(): React.JSX.Element {
  const open = useAppStore((store) => store.addLinksOpen)
  const draft = useAppStore((store) => store.addLinksDraft)
  const formKey = useAppStore((store) => store.addLinksKey)
  const close = useAppStore((store) => store.closeAddLinks)

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/60 [-webkit-app-region:no-drag]" />
        <DialogPrimitive.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[12px] bg-popover text-popover-foreground shadow-[0_24px_60px_rgba(0,0,0,0.35),0_2px_8px_rgba(0,0,0,0.15)] ring-1 ring-foreground/10 outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 [-webkit-app-region:no-drag]">
          {/* Keyed per opening, so each starts from the text it was opened with — and stays as it
           * was while closing, rather than emptying mid-animation. */}
          <AddLinksForm key={formKey} initialText={draft} onDone={close} />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function AddLinksForm({
  initialText,
  onDone
}: {
  initialText: string
  onDone: () => void
}): React.JSX.Element {
  const queue = useAppStore((store) => store.queue)
  const setQueueOpen = useAppStore((store) => store.setQueueOpen)
  const [text, setText] = useState(initialText)
  const [startNow, setStartNow] = useState(true)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsed = useMemo(() => parseLinks(text), [text])
  const waiting = useMemo(
    () =>
      new Set(
        (queue?.items ?? [])
          .filter((item) => item.status !== 'completed' && item.status !== 'failed')
          .map((item) => item.url)
      ),
    [queue]
  )
  const fresh = parsed.urls.filter((url) => !waiting.has(url))
  const alreadyQueued = parsed.urls.length - fresh.length

  const notes: string[] = []
  if (alreadyQueued > 0) notes.push(`${alreadyQueued} already queued`)
  if (parsed.repeated > 0) notes.push(`${parsed.repeated} repeated`)
  if (parsed.unreadable > 0) {
    notes.push(`${parsed.unreadable} ${parsed.unreadable === 1 ? 'line' : 'lines'} without a link`)
  }

  const handleAdd = async (): Promise<void> => {
    if (fresh.length === 0 || adding) return
    setAdding(true)
    setError(null)
    try {
      await window.plexo.addToQueue(
        fresh.map((url) => ({ url })),
        { start: startNow }
      )
      onDone()
      setQueueOpen(true)
    } catch (caught) {
      setError(describeError(caught))
      setAdding(false)
    }
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void handleAdd()
      }}
    >
      <div className="flex items-start gap-3 px-5 pt-[18px] pr-12">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <DialogPrimitive.Title className="font-sans text-[15px] leading-none font-bold tracking-[-0.01em]">
            Add links to the queue
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="font-sans text-[12px] leading-[1.45] text-[var(--text-secondary)]">
            One link per line. They download one after another, into the same folder.
          </DialogPrimitive.Description>
        </div>
      </div>

      <div className="flex flex-col gap-2.5 px-5 pt-3.5 pb-4">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds lines; Ctrl/⌘+Enter adds the links.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void handleAdd()
            }
          }}
          placeholder={'https://example.com/part1.zip\nhttps://example.com/part2.zip'}
          spellCheck={false}
          aria-label="Links, one per line"
          className="h-44 w-full resize-none rounded-[9px] border border-input bg-[var(--input-bg)] px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-foreground outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
        <div className="flex min-h-4 items-baseline gap-2 font-mono text-[11px] leading-none tabular-nums">
          <span className="font-semibold text-foreground">
            {fresh.length} {fresh.length === 1 ? 'link' : 'links'}
          </span>
          {notes.length > 0 && <span className="text-muted-foreground">· {notes.join(' · ')}</span>}
        </div>

        <QueueDestination />

        <label className="flex w-fit cursor-pointer items-center gap-2 font-sans text-[12px] text-[var(--text-secondary)] select-none">
          <Checkbox checked={startNow} onCheckedChange={(checked) => setStartNow(checked)} />
          Start downloading right away
        </label>

        {error && (
          <div role="alert" className="font-sans text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 rounded-b-[12px] border-t-[0.5px] border-border bg-secondary px-5 py-3">
        <DialogPrimitive.Close render={<Button type="button" variant="secondary" size="sm" />}>
          Cancel
        </DialogPrimitive.Close>
        <Button type="submit" size="sm" disabled={fresh.length === 0 || adding}>
          <ListPlus data-icon="inline-start" />
          {fresh.length > 0
            ? `Add ${fresh.length} ${fresh.length === 1 ? 'link' : 'links'}`
            : 'Add links'}
        </Button>
      </div>
      {/* Last in the DOM so the text box, not this, gets the dialog's initial focus. */}
      <DialogPrimitive.Close
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            className="absolute top-3 right-3 text-muted-foreground"
          />
        }
      >
        <X />
      </DialogPrimitive.Close>
    </form>
  )
}
