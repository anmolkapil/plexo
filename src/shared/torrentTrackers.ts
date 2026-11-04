const VALID_TRACKER_SCHEMES = new Set(['http:', 'https:', 'udp:', 'ws:', 'wss:'])

/**
 * Normalizes and validates a tracker announce URL.
 * Strips whitespace and trailing slashes, ensuring standard BitTorrent tracker schemes.
 * Returns null if the URL is invalid or uses an unsupported scheme.
 */
export function normalizeTrackerUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (!VALID_TRACKER_SCHEMES.has(parsed.protocol)) return null
    if (!parsed.hostname) return null

    return parsed.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

/**
 * Parses a block of text containing tracker URLs separated by newlines, commas, or spaces.
 * Drops invalid or duplicate URLs.
 */
export function parseTrackerList(input: string): string[] {
  const tokens = input.split(/[\r\n,]+/)
  const result: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    const normalized = normalizeTrackerUrl(token)
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase())
      result.push(normalized)
    }
  }

  return result
}

/**
 * Merges new tracker URLs into an existing tracker list without duplicates.
 */
export function mergeTrackers(
  existing: readonly string[],
  additional: readonly string[]
): string[] {
  const result = [...existing]
  const seen = new Set(
    existing.map((url) => normalizeTrackerUrl(url)?.toLowerCase() ?? url.toLowerCase())
  )

  for (const item of additional) {
    const normalized = normalizeTrackerUrl(item)
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase())
      result.push(normalized)
    }
  }

  return result
}
