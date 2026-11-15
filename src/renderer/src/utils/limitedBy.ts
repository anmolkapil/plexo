import { describeError } from '@shared/errors'
import type { DownloadState } from '@shared/types'

/** The line under the total speed, a word more on hover, and where it can be changed:
 * `limits` opens Speed & data limits, on the network's page when it's one network's. */
export interface LimitLine {
  text: string
  detail: string
  limits?: { page: string | null }
}

/** What the server is, as the screen calls it for this kind of download. */
function serverOf(download: Pick<DownloadState, 'kind'>): string {
  return download.kind === 'torrent'
    ? 'any peers'
    : download.kind === 'nzb'
      ? 'the news server'
      : download.kind === 'telegram'
        ? 'Telegram'
        : 'this server'
}

/** The download's limitedBy in words, or null when nothing holds it back. A network it no
 * longer lists is called "A network". */
export function describeLimit(
  download: Pick<DownloadState, 'kind' | 'limitedBy' | 'networks'>
): LimitLine | null {
  const limit = download.limitedBy
  if (!limit) return null
  const name = (id: string): string =>
    download.networks.find((network) => network.id === id)?.label ?? 'A network'
  switch (limit.reason) {
    case 'slow-mode':
      return {
        text: 'Limited by slow mode',
        detail: 'Slow mode keeps every download to its speed. Switch it off to go faster.',
        limits: { page: null }
      }
    case 'speed-limit':
      return {
        text: 'Limited by your speed limit',
        detail: 'Your speed limit keeps every download to it.',
        limits: { page: null }
      }
    case 'data-limit':
      return {
        text: `${name(limit.network)} reached its data limit`,
        detail: `${name(limit.network)} isn’t used until its data limit resets or you raise it.`,
        limits: { page: limit.network }
      }
    case 'network-speed-limit':
      return {
        text: `Limited by ${name(limit.network)}’s speed limit`,
        detail: `${name(limit.network)} is kept to the speed limit you set for it.`,
        limits: { page: limit.network }
      }
    case 'unreachable':
      return {
        text: `${name(limit.network)} can’t reach ${serverOf(download)}`,
        detail: `The other networks carry on. ${name(limit.network)} keeps trying and joins in once it gets through.`
      }
    case 'failed': {
      // Refused, sent wrong answers, or redirected where it can't go: what it says is its own.
      const error = download.networks.find((network) => network.id === limit.network)?.error
      const said = error ? describeError(error) : ''
      const why = said && (/[.!?]$/.test(said) ? `${said} ` : `${said}. `)
      return {
        text: `${name(limit.network)} isn’t used: it kept failing`,
        detail: `${why}Switch it off and on to try it again.`
      }
    }
    case 'disk':
      return {
        text: 'Limited by your drive',
        detail: 'Your drive can’t save any faster, so this download is going slower.'
      }
    case 'one-connection':
      return download.networks.length > 1
        ? {
            text: 'Only one network can be used for this download',
            detail:
              'The server sends this file in one piece, over one connection, so it can’t be split across networks.'
          }
        : {
            text: 'Limited by the server: it allows one connection',
            detail: 'The server sends this file in one piece, over one connection.'
          }
    case 'server-connections': {
      const count = `${limit.connections} ${limit.connections === 1 ? 'connection' : 'connections'}`
      const on = download.networks.filter((network) => network.status === 'on').length
      return {
        text: `Limited by the server: it allows ${count}${on > 1 ? ' per network' : ''}`,
        detail: 'The server turned more connections away. Plexo tries one more every minute.'
      }
    }
  }
}
