import type { DownloadNetwork, DownloadState } from './types'

// How much sooner a finished download came in for combining networks: what the Complete screen
// and the "Download complete" notification say, when there's something worth saying.
//
// The estimate: each network's speed is what it delivered over the time it was delivering
// (activeMs: the ticks it had bytes arrive in). The fastest of them is the one the download would
// have used alone, and the file at that speed is how long it would have taken. Less the time it
// did take is the saving.
//
// It's an estimate, and only ever said with "about". A network's speed while bonded isn't quite
// its speed alone: when the networks share a bottleneck (one router behind both, a server's limit
// on the whole download, a slow disk), each ran slower beside the other than it would have by
// itself, and the saving reads larger than it was. Nothing here can tell that apart. Elsewhere it
// leans the other way: the time taken includes what any download spends before and after its
// bytes (asking the server, putting the file in place), which alone would have taken too, and a
// network's gaps (a stream retrying) aren't active time, so it reads a little faster than it was.
// The floors below keep it quiet unless the difference is clear.

/** Shorter, and the start (every connection opening) and the end (the last blocks) are most of
 * it: no speed is read well enough to compare. */
const MIN_SECONDS = 10
/** Of the bytes, the share a network needs for the download to count as combined. */
const MIN_SHARE = 0.05
/** The least saving worth a line: this many seconds, and this share of the time alone. */
const MIN_SAVED_SECONDS = 5
const MIN_SAVED_SHARE = 0.05

export interface TimeSaved {
  /** Seconds sooner than the fastest network alone. */
  seconds: number
  /** That network. */
  network: DownloadNetwork
}

type Finished = Pick<
  DownloadState,
  'kind' | 'networks' | 'startedAt' | 'completedAt' | 'totalPausedMs'
>

/** How long it took start to finish, pauses left out. */
export function downloadingSeconds(
  download: Pick<DownloadState, 'startedAt' | 'completedAt' | 'totalPausedMs'>
): number {
  // completedAt is always set by the time a download reaches 'completed' — the fallback here is
  // just to keep this pure (no Date.now() during render).
  const ms =
    (download.completedAt ?? download.startedAt) -
    download.startedAt -
    (download.totalPausedMs ?? 0)
  return Math.max(0, ms / 1000)
}

/** The saving, given how long it took and what each network did; null when there's none worth
 * saying, or no telling: fewer than two networks with a real share, too short to read, or a
 * network without its active time (a download from before it was kept). */
export function estimateTimeSaved(
  elapsedSeconds: number,
  networks: readonly DownloadNetwork[]
): TimeSaved | null {
  if (!(elapsedSeconds >= MIN_SECONDS)) return null
  const delivered = networks.filter((network) => network.bytesDownloaded > 0)
  const total = delivered.reduce((sum, network) => sum + network.bytesDownloaded, 0)
  if (delivered.filter((network) => network.bytesDownloaded / total >= MIN_SHARE).length < 2) {
    return null
  }
  // Unset in a download from before it was kept; not a number, in a hand-edited history.
  if (delivered.some((network) => !Number.isFinite(network.activeMs))) return null
  // At least a second, as a speed meter reads (see Meter): a network that delivered in a single
  // tick would read as fast as one burst. Never longer than the download itself.
  const speedOf = (network: DownloadNetwork): number =>
    network.bytesDownloaded / Math.min(Math.max((network.activeMs ?? 0) / 1000, 1), elapsedSeconds)
  const fastest = delivered.reduce((best, network) =>
    speedOf(network) > speedOf(best) ? network : best
  )
  const aloneSeconds = total / speedOf(fastest)
  const seconds = aloneSeconds - elapsedSeconds
  if (seconds < MIN_SAVED_SECONDS || seconds < aloneSeconds * MIN_SAVED_SHARE) return null
  return { seconds, network: fastest }
}

/** The saving for a finished download. Telegram's bytes are credited to a network as each block
 * is claimed, but go however the OS routes them (see TelegramDownloadState), so what each network
 * did there is no reading of its speed. */
export function timeSavedOf(download: Finished): TimeSaved | null {
  if (download.kind === 'telegram') return null
  return estimateTimeSaved(downloadingSeconds(download), download.networks)
}

/** "about 4 min sooner than Wi-Fi alone": rounded as far as an estimate deserves, to 5 seconds
 * under a minute and to the minute above. */
export function describeTimeSaved(seconds: number, networkName: string): string {
  return `about ${roughDuration(seconds)} sooner than ${networkName} alone`
}

function roughDuration(seconds: number): string {
  if (seconds < 57.5) return `${Math.max(5, Math.round(seconds / 5) * 5)} sec`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`
}
