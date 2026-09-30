import { useLayoutEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** How much of a long name's end always stays in view. */
const TAIL = 16

/**
 * A file name that, when it doesn't fit, loses its middle rather than its end:
 * "TheWitcher3Wild…[DODIRepack].part03.rar". Multi-part archives and numbered episodes differ only
 * at the end, so an ordinary ellipsis would make a whole queue of them look the same. Like
 * TruncatedText, the full name is a tooltip away only when some of it is hidden.
 */
export function FileNameText({
  name,
  tooltipText = name,
  className = ''
}: {
  name: string
  tooltipText?: string
  className?: string
}): React.JSX.Element {
  const cut = name.length > TAIL + 4 ? name.length - TAIL : name.length
  const [head, setHead] = useState<HTMLSpanElement | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    if (!head) return
    const measure = (): void => setIsTruncated(head.scrollWidth > head.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(head)
    return () => observer.disconnect()
  }, [head, name])

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={
          <span
            tabIndex={isTruncated ? 0 : undefined}
            aria-label={name}
            // A full line box, as TruncatedText keeps, so descenders aren't clipped.
            className={`inline-flex max-w-full min-w-0 align-bottom leading-normal outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 ${className}`}
          >
            <span ref={setHead} aria-hidden="true" className="min-w-0 truncate">
              {name.slice(0, cut)}
            </span>
            <span aria-hidden="true" className="shrink-0 whitespace-pre">
              {name.slice(cut)}
            </span>
          </span>
        }
      />
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  )
}
