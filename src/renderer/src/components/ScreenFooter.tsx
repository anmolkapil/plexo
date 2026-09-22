import { cn } from 'cn'

/** The bottom bar every screen ends on — border, background and padding are fixed, `className`
 * only tunes per-screen gap/alignment. */
export function ScreenFooter({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-t-[0.5px] border-t-[var(--footer-border)] bg-secondary px-5 py-[11px]',
        className
      )}
    >
      {children}
    </div>
  )
}
