import { Badge } from './ui/badge'

/** Next to an NZB download's name, wherever it's listed, as TorrentBadge is beside a torrent's. */
export function UsenetBadge(): React.JSX.Element {
  return (
    <Badge
      variant="outline"
      className="h-4 rounded-[3.5px] px-[6px] font-mono text-[9.5px] leading-none font-semibold tracking-[0.08em] text-muted-foreground"
    >
      USENET
    </Badge>
  )
}
