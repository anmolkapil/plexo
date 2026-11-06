const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const NESTED_ERROR_PREFIX = /^Error:\s*/

/** A link that worked and then stopped: signed links run out, and a server turns them away. */
const LINK_REFUSED = /status (401|403|404|410|416) for range request/

/** Whether an error says the server refused this download's byte range: its link is no longer
 * good, and a fresh one to the same file is what carries on. */
export function linkRefused(error: string | undefined | null): boolean {
  return !!error && LINK_REFUSED.test(error)
}

const ERROR_HINTS: Array<{ pattern: RegExp; code: string; message: string }> = [
  {
    pattern: /ENOSPC|EDQUOT/,
    code: 'no_space',
    message:
      'There isn’t enough space to save this download. Free up space or choose another folder.'
  },
  {
    pattern: /EACCES|EPERM/,
    code: 'permission',
    message:
      'Plexo doesn’t have permission to access this file or folder. Check its permissions or choose another folder.'
  },
  {
    pattern: /ENOENT/,
    code: 'missing_file',
    message: 'The file or folder is missing. Check the download location and try again.'
  },
  {
    pattern: /EROFS/,
    code: 'read_only',
    message: 'This drive is read-only. Choose another download folder.'
  },
  {
    pattern: /EIO/,
    code: 'disk_io',
    message: 'Plexo couldn’t read or write the download. Check the drive and try again.'
  },
  {
    pattern:
      /Invalid torrent metadata|Invalid torrent|Invalid info hash|Invalid infoHash|Invalid magnet/i,
    code: 'torrent_invalid',
    message: 'Plexo couldn’t read this torrent. Try another magnet link or .torrent file.'
  },
  {
    pattern: LINK_REFUSED,
    code: 'link_refused',
    message: 'This link no longer works. Paste a new link to continue.'
  },
  {
    pattern: /Download is incomplete/,
    code: 'incomplete',
    message: 'Plexo couldn’t download every part of the file. Try downloading again.'
  },
  {
    pattern: /Download file size does not match/,
    code: 'size_mismatch',
    message:
      'The downloaded file has an unexpected size. Plexo couldn’t save the completed file. Try downloading again.'
  },
  {
    pattern: /Proxy authentication required|HTTP 407/i,
    code: 'proxy_auth',
    message: 'Proxy authentication failed — check your proxy username and password.'
  },
  {
    pattern: /SOCKS5 authentication failed/i,
    code: 'proxy_auth',
    message: 'SOCKS5 proxy authentication failed — check your username and password.'
  },
  {
    pattern: /Connecting to proxy .* timed out/i,
    code: 'proxy_timeout',
    message: 'Connecting to proxy timed out — check the proxy host, port, and your network.'
  },
  {
    pattern: /Proxy CONNECT failed/i,
    code: 'proxy_refused',
    message: 'The HTTP proxy rejected the connection request.'
  },
  {
    pattern: /SOCKS[45] connection (?:rejected|failed)/i,
    code: 'proxy_refused',
    message: 'The SOCKS proxy rejected the connection — check your proxy settings.'
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/,
    code: 'dns',
    message: 'Plexo couldn’t find the server. Check the link and your connection.'
  },
  {
    pattern: /ECONNREFUSED/,
    code: 'conn_refused',
    message: 'The server refused the connection. Try again later.'
  },
  {
    pattern: /ECONNRESET|socket hang up/,
    code: 'conn_reset',
    message: 'The connection was interrupted. Try again in a moment.'
  },
  {
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/,
    code: 'timeout',
    message: 'The connection timed out. Check your network and try again.'
  },
  {
    // What Node and OpenSSL say, not any message that names a file or host with TLS or SSL in it.
    pattern: /certificate|SSL routines|secure TLS connection/,
    code: 'tls',
    message:
      'The server’s security certificate couldn’t be verified. Check the link or try again later.'
  },
  {
    pattern: /Invalid URL|ERR_INVALID_URL/,
    code: 'invalid_url',
    message: 'That doesn’t look like a valid link.'
  },
  {
    pattern: /(?:Server responded with|Unexpected) status 401\b/,
    code: 'http_401',
    message: 'This link requires authentication. Try a direct download link.'
  },
  {
    pattern: /(?:Server responded with|Unexpected) status 403\b/,
    code: 'http_403',
    message: 'The server denied access to this file. Check the link or try a new one.'
  },
  {
    pattern: /(?:Server responded with|Unexpected) status 404\b/,
    code: 'http_404',
    message: 'The file couldn’t be found. Check the link and try again.'
  },
  {
    pattern: /(?:Server responded with|Unexpected) status 4\d\d\b/,
    code: 'http_4xx',
    message: 'The server rejected the download. Check the link and try again.'
  },
  {
    pattern: /(?:Server responded with|Unexpected) status 5\d\d\b/,
    code: 'http_5xx',
    message: 'The server is having trouble. Try again later.'
  }
]

/** Electron wraps a rejected IPC call as "Error invoking remote method 'x': Error: <message>" —
 * strip that framework noise and translate common network errors and internal consistency-check
 * failures into plain English. Used for both the pre-download probe and a download's own
 * `error` field, so a failure partway through a transfer reads exactly as friendly as one caught
 * before it started. */
export function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(IPC_INVOKE_PREFIX, '').replace(NESTED_ERROR_PREFIX, '')

  for (const { pattern, message } of ERROR_HINTS) {
    if (pattern.test(stripped)) return message
  }

  return stripped
}

/** Errors with no message of their own above, sorted for the anonymous stats (see stats.ts). */
const MORE_CLASSES: Array<{ pattern: RegExp; code: string }> = [
  { pattern: /Too many redirects/i, code: 'too_many_redirects' },
  { pattern: /more than the requested range/, code: 'bad_range' },
  { pattern: /Usenet is switched off/i, code: 'usenet_off' },
  { pattern: /net::ERR_INTERNET_DISCONNECTED|ENETUNREACH|EHOSTUNREACH/, code: 'offline' },
  { pattern: /net::ERR_/, code: 'net_error' }
]

/** A short, fixed code for an error — `dns`, `http_403`, `no_space`, … — or `other`. Never any of
 * the error's own text, which can name a link, a host, a proxy or a file. */
export function errorClass(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  for (const { pattern, code } of [...ERROR_HINTS, ...MORE_CLASSES]) {
    if (pattern.test(raw)) return code
  }
  return 'other'
}

/** The status code in an error that names one ("status 403"), or ''. */
export function errorStatus(error: string | undefined): string {
  const match = error && /\bstatus (\d{3})\b/.exec(error)
  return match ? match[1] : ''
}
