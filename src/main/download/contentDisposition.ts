/**
 * Decode a single RFC 2047 encoded-word (=?charset?B|Q?…?=), or return the
 * input unchanged when it is not one. Mail gateways still put these in
 * Content-Disposition filename= values.
 */
export function decodeRfc2047Word(value: string): string {
  const match = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(value.trim())
  if (!match) return value
  const charset = match[1]
  const encoding = match[2].toUpperCase()
  const text = match[3]
  let bytes: Buffer
  if (encoding === 'B') {
    try {
      bytes = Buffer.from(text, 'base64')
    } catch {
      return value
    }
  } else {
    // Q-encoding: _ is space; =XX is a byte
    const expanded = text
      .replace(/_/g, ' ')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    bytes = Buffer.from([...expanded].map((c) => c.charCodeAt(0) & 0xff))
  }
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    try {
      return new TextDecoder('utf-8').decode(bytes)
    } catch {
      return value
    }
  }
}

/**
 * If the whole filename is one encoded-word, or a sequence of them separated
 * by whitespace (RFC 2047 §6.2), decode them. Otherwise leave as-is.
 */
export function decodeRfc2047Filename(name: string): string {
  const trimmed = name.trim()
  if (!/=\?[^?]+\?[bBqQ]\?[^?]*\?=/.test(trimmed)) return name
  // Contiguous encoded-words may be separated by linear whitespace only.
  const parts = trimmed.split(/(\s+)/)
  let any = false
  const out = parts.map((part) => {
    if (/^\s+$/.test(part)) return '' // collapse whitespace between encoded-words
    if (/^=\?[^?]+\?[bBqQ]\?[^?]*\?=$/.test(part)) {
      any = true
      return decodeRfc2047Word(part)
    }
    return part
  })
  return any ? out.join('') : name
}

export function parseContentDispositionFilename(disposition: string): string | null {
  // RFC 6266 / RFC 5987: filename* takes precedence over filename
  // format: filename*=charset'language'encoded-value
  const extMatch = /\bfilename\*=([a-zA-Z0-9_-]+)'[^']*'([^;\s]+)/i.exec(disposition)
  if (extMatch?.[2]) {
    // RFC 5987 requires both UTF-8 and ISO-8859-1. decodeURIComponent only reads UTF-8, so a
    // Latin-1 byte like %A3 (£) would throw and leave the raw escapes as the name.
    if (/^iso-8859-1$/i.test(extMatch[1])) {
      return extMatch[2].replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      )
    }
    try {
      return decodeURIComponent(extMatch[2])
    } catch {
      return extMatch[2]
    }
  }

  // Quoted string: preserves semicolons inside quotes, e.g. filename="report; final.pdf"
  const quotedMatch = /\bfilename="((?:[^"\\]|\\.)*)"/i.exec(disposition)
  if (quotedMatch?.[1]) {
    const unescaped = quotedMatch[1].replace(/\\(.)/g, '$1')
    let decoded: string
    try {
      decoded = decodeURIComponent(unescaped)
    } catch {
      decoded = unescaped
    }
    return decodeRfc2047Filename(decoded)
  }

  // Unquoted token fallback
  const tokenMatch = /\bfilename=([^;\s]+)/i.exec(disposition)
  if (tokenMatch?.[1]) {
    let decoded: string
    try {
      decoded = decodeURIComponent(tokenMatch[1])
    } catch {
      decoded = tokenMatch[1]
    }
    return decodeRfc2047Filename(decoded)
  }

  return null
}
