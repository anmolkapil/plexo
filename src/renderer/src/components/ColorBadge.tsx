import { cn } from 'cn'
import { Badge } from './ui/badge'

/** A `Badge` tinted with an arbitrary bg/border/text triple — for the many places a status or
 * network-kind label needs colors that come from `resolveNetworkVisual`/`KIND_PALETTE` at
 * runtime rather than from a fixed shadcn variant. The triple travels as CSS custom properties
 * (not a `style` object with literal color properties) so `className` can still win normal
 * Tailwind specificity fights, same trick this replaces from NetworkCard. */
export function ColorBadge({
  bg,
  border,
  text,
  className,
  style,
  ...props
}: {
  bg: string
  border: string
  text: string
} & React.ComponentProps<typeof Badge>): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      style={
        {
          ...style,
          '--badge-bg': bg,
          '--badge-border': border,
          '--badge-text': text
        } as React.CSSProperties
      }
      className={cn(
        // `leading-none` because `Badge`'s base `text-xs` also sets a 1rem line-height, and a
        // call site that shrinks the font with `text-[9px]` doesn't shrink that. On a badge left
        // at the base `h-5` that's invisible, but on an `h-auto` one it makes the box ~20px tall
        // next to 13px siblings — so the badge appearing (ACTIVE, PAUSED) grew its whole row.
        'rounded-[4px] border-[var(--badge-border)] bg-[var(--badge-bg)] text-[var(--badge-text)] leading-none',
        className
      )}
      {...props}
    />
  )
}
