import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cn } from 'cn'

/**
 * A panel that slides in from the window's right edge, below the title bar — which stays in view,
 * so what opened the panel (and what it reports) is still there. Modal: focus stays inside until
 * it closes, and a click on the dimmed window closes it. Enter and exit are transitions driven by
 * Base UI's starting/ending style attributes, like the app's alert dialogs.
 */
function Sheet(props: DialogPrimitive.Root.Props): React.JSX.Element {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="sheet-backdrop"
        className="fixed inset-x-0 top-11 bottom-0 z-40 bg-black/20 transition-opacity duration-200 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/45 [-webkit-app-region:no-drag]"
      />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          'fixed top-11 right-0 bottom-0 z-40 flex w-[min(420px,100vw)] flex-col border-l-[0.5px] border-[var(--border-strong)] bg-background text-foreground shadow-[-18px_0_44px_rgba(0,0,0,0.16)] outline-none [-webkit-app-region:no-drag] dark:shadow-[-18px_0_44px_rgba(0,0,0,0.45)]',
          'transition-transform duration-[260ms] ease-[cubic-bezier(0.22,1,0.36,1)] data-[ending-style]:translate-x-full data-[ending-style]:duration-[180ms] data-[ending-style]:ease-[cubic-bezier(0.4,0,1,1)] data-[starting-style]:translate-x-full',
          className
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

const SheetTitle = DialogPrimitive.Title
const SheetDescription = DialogPrimitive.Description
const SheetClose = DialogPrimitive.Close

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle }
