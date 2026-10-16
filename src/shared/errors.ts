const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/
const NESTED_ERROR_PREFIX = /^Error:\s*/

/** A link that worked and then stopped: signed links run out, and a server turns them away. */
const LINK_REFUSED = /status (401|403|404|410) for range request/

/** A certificate the client can't verify — untrusted, expired, issued for another host, or its
 * chain stopping short of a known root — as opposed to a TLS mismatch (an old protocol version,
 * a plain-HTTP port) that skipping verification wouldn't get past. */
const CERTIFICATE_PROBLEM =
  /CERT|SELF[-_ ]SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO|certificate/i

const ERROR_HINTS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /ENOSPC|EDQUOT/,
    message:
      'There isn’t enough space to save this download. Free up space or choose another folder.'
  },
  {
    pattern: /EACCES|EPERM/,
    message:
      'Plexo doesn’t have permission to access this file or folder. Check its permissions or choose another folder.'
  },
  {
    pattern: /ENOENT/,
    message: 'The file or folder is missing. Check the download location and try again.'
  },
  { pattern: /EROFS/, message: 'This drive is read-only. Choose another download folder.' },
  {
    pattern: /EIO/,
    message: 'Plexo couldn’t read or write the download. Check the drive and try again.'
  },
  {
    pattern:
      /Invalid torrent metadata|Invalid torrent|Invalid info hash|Invalid infoHash|Invalid magnet/i,
    message: 'Plexo couldn’t read this torrent. Try another magnet link or .torrent file.'
  },
  {
    pattern: LINK_REFUSED,
    message: 'This link no longer works. Paste a new link to continue.'
  },
  {
    pattern: /Download is incomplete/,
    message: 'Plexo couldn’t download every part of the file. Try downloading again.'
  },
  {
    pattern: /Download file size does not match/,
    message:
      'The downloaded file has an unexpected size. Plexo couldn’t save the completed file. Try downloading again.'
  },
  {
    pattern: /ENOTFOUND|EAI_AGAIN/,
    message: 'Plexo couldn’t find the server. Check the link and your connection.'
  },
  {
    pattern: /ECONNREFUSED/,
    message: 'The server refused the connection. Try again later.'
  },
  {
    pattern: /ECONNRESET|socket hang up/,
    message: 'The connection was interrupted. Try again in a moment.'
  },
  {
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/,
    message: 'The connection timed out. Check your network and try again.'
  },
  {
    pattern: /CERT|SSL|TLS/i,
    message:
      'The server’s security certificate couldn’t be verified. Check the link or try again later.'
  },
  {
    pattern: /Invalid URL|ERR_INVALID_URL/,
    message: 'That doesn’t look like a valid link.'
  },
  {
    pattern: /Server responded with status 401/,
    message: 'This link requires authentication. Try a direct download link.'
  },
  {
    pattern: /Server responded with status 403/,
    message: 'The server denied access to this file. Check the link or try a new one.'
  },
  {
    pattern: /Server responded with status 404/,
    message: 'The file couldn’t be found. Check the link and try again.'
  },
  {
    pattern: /Server responded with status 4\d\d/,
    message: 'The server rejected the download. Check the link and try again.'
  },
  {
    pattern: /Server responded with status 5\d\d/,
    message: 'The server is having trouble. Try again later.'
  }
]

/** Electron wraps a rejected IPC call as "Error invoking remote method 'x': Error: <message>" —
 * strip that framework noise and translate common network errors and internal consistency-check
 * failures into plain English. Used for both the pre-download probe and a download's own
 * `error` field, so a failure partway through a transfer reads exactly as friendly as one caught
 * before it started. */
export function describeError(error: unknown): string {
  const stripped = strippedMessage(error)

  for (const { pattern, message } of ERROR_HINTS) {
    if (pattern.test(stripped)) return message
  }

  return stripped
}

/** Whether a failure is the server's certificate. Only these can be downloaded past without
 * verifying it (see NewDownloadDialog): a TLS problem the certificate isn't behind — an old
 * protocol version, say — would fail the very same way with verification off. */
export function isCertificateError(error: unknown): boolean {
  return CERTIFICATE_PROBLEM.test(strippedMessage(error))
}

function strippedMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(IPC_INVOKE_PREFIX, '').replace(NESTED_ERROR_PREFIX, '')
}
