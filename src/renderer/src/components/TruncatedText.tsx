import { useLayoutEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/** Renders `text` truncated with an ellipsis, and only wires up a tooltip when it's actually cut
 * off — hovering text that already fits has nothing more to reveal. `tooltipText` lets the
 * tooltip show something fuller than what's on screen (e.g. an abbreviated path's real value)
 * when it defaults to `text` isn't enough. */
export function TruncatedText({
  text,
  tooltipText = text,
  className = ''
}: {
  text: string
  tooltipText?: string
  className?: string
}): React.JSX.Element {
  const [node, setNode] = useState<HTMLSpanElement | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    if (!node) return
    const measure = (): void => setIsTruncated(node.scrollWidth > node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [node, text])

  return (
    <Tooltip open={isTruncated ? undefined : false}>
      <TooltipTrigger
        render={
          <span
            ref={setNode}
            // Focusable only when actually truncated — untruncated text has nothing more to
            // reveal, and a keyboard user needs some way to reach the tooltip a mouse user gets
            // via hover.
            tabIndex={isTruncated ? 0 : undefined}
            className={`inline-block max-w-full truncate align-bottom outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 ${className}`}
          >
            {text}
          </span>
        }
      />
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  )
}
