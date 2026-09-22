import { cn } from 'cn'

/** The dark panel every screen opens on — always this exact panel from the design regardless of
 * the app's own light/dark theme, so its children (labels, diagrams, charts) stay legible no
 * matter which OS appearance the rest of the window is following. */
export function HeroBand({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-b border-b-[var(--hero-border)] bg-[image:var(--hero-bg)] px-5 py-[18px] text-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}
