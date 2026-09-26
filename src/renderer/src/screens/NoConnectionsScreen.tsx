import { CombineDiagram } from '../components/CombineDiagram'
import { ScreenFooter } from '../components/ScreenFooter'
import { Button } from '../components/ui/button'
import { useAppStore } from '../store/useAppStore'

// Colors are irrelevant here — the diagram is rendered `muted`, which overrides them all to
// var(--icon-muted) — these are just three placeholder rows to draw the illustration with.
const PLACEHOLDER_NETWORKS = [
  { solid: 'var(--icon-muted)', label: 'Wi-Fi' },
  { solid: 'var(--icon-muted)', label: 'USB' },
  { solid: 'var(--icon-muted)', label: 'Ethernet' }
]

export function NoConnectionsScreen(): React.JSX.Element {
  const loadInterfaces = useAppStore((store) => store.loadInterfaces)

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-5 pt-10 pb-11">
        <CombineDiagram networks={PLACEHOLDER_NETWORKS} muted />
        <div className="font-sans text-[16px] leading-[1.2] font-bold text-foreground">
          No networks to combine
        </div>
        <div className="max-w-[380px] text-center font-sans text-[12.5px] leading-[1.6] text-[var(--text-secondary)]">
          Plexo needs at least one active network. Join a Wi-Fi network, plug in Ethernet, or
          connect an iPhone over USB with Personal Hotspot enabled.
        </div>
        <div className="mt-1 flex gap-2">
          <Button type="button" variant="secondary" onClick={() => loadInterfaces()}>
            Scan Again
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => window.plexo.openNetworkSettings()}
          >
            Network Settings…
          </Button>
        </div>
      </div>

      <ScreenFooter className="gap-2.5">
        <div className="font-mono text-[11px] leading-[1.4] text-muted-foreground">
          0 networks · watching for changes
        </div>
        <div className="flex-1" />
        <Button type="button" disabled>
          Start
        </Button>
      </ScreenFooter>
    </div>
  )
}
