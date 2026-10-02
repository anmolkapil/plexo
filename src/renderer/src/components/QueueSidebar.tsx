import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { XIcon, ArrowUpIcon, ArrowDownIcon, ListIcon } from 'lucide-react'

export function QueueSidebar(): React.JSX.Element | null {
  const queuedUrls = useAppStore((store) => store.queuedUrls)
  const queueUrl = useAppStore((store) => store.queueUrl)
  const removeQueuedUrl = useAppStore((store) => store.removeQueuedUrl)
  const moveQueuedUrl = useAppStore((store) => store.moveQueuedUrl)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState(false)

  const handleAdd = (): void => {
    let raw = input.trim()
    if (!raw) return

    if (!/^https?:\/\//i.test(raw)) {
      raw = `https://${raw}`
    }

    try {
      new URL(raw)
      queueUrl(raw)
      setInput('')
      setInputError(false)
    } catch {
      setInputError(true)
    }
  }

  // Only show sidebar if there's something in the queue or if we are downloading (so user can queue more).
  // Actually, keeping it always visible gives a consistent layout.
  // We'll keep it always visible but give it a fixed width.
  return (
    <div className="flex w-64 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <ListIcon className="size-4 text-muted-foreground" />
        <h3 className="font-sans text-[13px] font-semibold tracking-tight">
          Queue {queuedUrls.length > 0 ? `(${queuedUrls.length})` : ''}
        </h3>
      </div>

      <div className="flex flex-col gap-2 p-3">
        <input
          type="url"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setInputError(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Add URL to queue..."
          className={`h-8 rounded-md border bg-background px-3 py-1 font-mono text-[11px] outline-none transition-colors ${
            inputError
              ? 'border-destructive focus-visible:ring-1 focus-visible:ring-destructive'
              : 'border-input focus-visible:ring-1 focus-visible:ring-ring'
          }`}
        />
        <Button onClick={handleAdd} size="sm" className="h-8">
          Add
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 pt-0">
        {queuedUrls.length === 0 ? (
          <div className="py-4 text-center text-[11px] text-muted-foreground">Queue is empty</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {queuedUrls.map((url, i) => (
              <li
                key={i}
                className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2"
              >
                <div className="truncate font-mono text-[10px] text-foreground" title={url}>
                  {url}
                </div>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    onClick={() => moveQueuedUrl(i, 'up')}
                    disabled={i === 0}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5"
                    onClick={() => moveQueuedUrl(i, 'down')}
                    disabled={i === queuedUrls.length - 1}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5 text-muted-foreground hover:text-destructive"
                    onClick={() => removeQueuedUrl(i)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
