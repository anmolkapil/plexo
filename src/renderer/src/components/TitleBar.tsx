import { useEffect, useState } from 'react'
import { TITLE_BAR_HEIGHT } from '../theme'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

const isMac = window.plexo.platform === 'darwin'
const isWin = window.plexo.platform === 'win32'

interface CaptionButtonProps {
  label: string
  onClick: () => void
  className: string
  children: React.ReactNode
}

function CaptionButton({
  label,
  onClick,
  className,
  children
}: CaptionButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={`flex h-full w-[46px] items-center justify-center text-[var(--text)] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${className}`}
          >
            {children}
          </button>
        }
      />
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function WindowsControls(): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let active = true
    void window.plexo.windowIsMaximized().then((value) => {
      if (active) setMaximized(value)
    })
    const unsubscribe = window.plexo.onWindowMaximizedChanged((value) => {
      setMaximized(value)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  const neutralHover = 'hover:bg-foreground/10 active:bg-foreground/15'

  return (
    <TooltipProvider delay={500}>
      <div className="absolute inset-y-0 right-0 flex items-stretch [-webkit-app-region:no-drag]">
        <CaptionButton
          label="Minimize"
          onClick={() => void window.plexo.windowMinimize()}
          className={neutralHover}
        >
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            shapeRendering="crispEdges"
          >
            <line x1="0" y1="5" x2="10" y2="5" />
          </svg>
        </CaptionButton>
        <CaptionButton
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void window.plexo.windowToggleMaximize().then(setMaximized)}
          className={neutralHover}
        >
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            shapeRendering="crispEdges"
          >
            {maximized ? (
              <>
                <path d="M2.5 2.5V0.5H9.5V7.5H7.5" />
                <rect x="0.5" y="2.5" width="7" height="7" />
              </>
            ) : (
              <rect x="0.5" y="0.5" width="9" height="9" />
            )}
          </svg>
        </CaptionButton>
        <CaptionButton
          label="Close"
          onClick={() => void window.plexo.windowClose()}
          className="hover:bg-[#c42b1c] hover:text-white active:bg-[#b22719]"
        >
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          >
            <path d="M1 1L9 9M9 1L1 9" />
          </svg>
        </CaptionButton>
      </div>
    </TooltipProvider>
  )
}

/** The window's title bar, the same on every OS: its name, centered, on a strip the window is
 * dragged by. macOS's traffic lights sit at the left, Linux's titleBarOverlay sits at the right,
 * and Windows renders custom caption controls at the right to avoid the OS double-tooltip bug. */
export function TitleBar(): React.JSX.Element {
  return (
    <div
      style={{ height: TITLE_BAR_HEIGHT }}
      className={`relative flex shrink-0 items-center justify-center border-b-[0.5px] border-border bg-card [-webkit-app-region:drag] ${
        // Clear of the controls on either side, so the name stays centered between them.
        isMac ? 'px-[94px]' : 'px-[140px]'
      }`}
    >
      <div className="truncate font-sans text-[13px] leading-none font-semibold text-[var(--text-secondary)]">
        Plexo
      </div>
      {isWin ? <WindowsControls /> : null}
    </div>
  )
}
