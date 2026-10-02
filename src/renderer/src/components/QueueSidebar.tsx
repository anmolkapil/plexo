import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/button'
import { XIcon, ArrowUpIcon, ArrowDownIcon } from 'lucide-react'

const sectionHeaderClass =
  'font-mono text-[10px] leading-none tracking-[0.16em] text-muted-foreground uppercase'

export function QueueSidebar(): React.JSX.Element {
  const queuedUrls = useAppStore((store) => store.queuedUrls)
  const removeQueuedUrl = useAppStore((store) => store.removeQueuedUrl)
  const moveQueuedUrl = useAppStore((store) => store.moveQueuedUrl)

  return (
    <div className="flex w-[260px] shrink-0 flex-col border-l border-border bg-card">
      {/* Consistent header with Plexo */}
      <div className="flex h-12 items-center border-b border-border px-4">
        <h2 className={sectionHeaderClass}>
          Queue {queuedUrls.length > 0 ? `(${queuedUrls.length})` : ''}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {queuedUrls.length === 0 ? (
          <div className="mt-8 text-center font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
            Empty
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {queuedUrls.map((item, i) => (
              <li
                key={i}
                className="flex flex-col gap-2 rounded-[6px] border border-border bg-background p-2.5 shadow-sm"
              >
                <div
                  className="break-all font-mono text-[10px] text-foreground leading-relaxed"
                  title={item.url}
                >
                  {item.url}
                </div>
                {item.streamsPerNetwork && (
                  <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">
                    {item.streamsPerNetwork} streams
                  </div>
                )}
                <div className="flex items-center justify-end gap-1 mt-1">
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-6 w-6 p-0"
                    onClick={() => moveQueuedUrl(i, 'up')}
                    disabled={i === 0}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-6 w-6 p-0"
                    onClick={() => moveQueuedUrl(i, 'down')}
                    disabled={i === queuedUrls.length - 1}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
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
