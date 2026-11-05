const VALID_TRACKER_SCHEMES = new Set(['http:', 'https:', 'udp:'])
const MAX_TRACKER_URL_LENGTH = 2048

/**
 * Normalizes and validates a tracker announce URL.
 * Strips whitespace and trailing slashes, ensuring standard BitTorrent tracker schemes (udp, http, https).
 * Returns null if the URL is invalid, exceeds 2048 characters, or uses an unsupported scheme.
 */
export function normalizeTrackerUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (!trimmed || trimmed.length > MAX_TRACKER_URL_LENGTH) return null

  try {
    const parsed = new URL(trimmed)
    if (!VALID_TRACKER_SCHEMES.has(parsed.protocol)) return null
    if (!parsed.hostname) return null

    return parsed.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface ParsedTrackers {
  valid: string[]
  invalidCount: number
}

/**
 * Parses a block of text containing tracker URLs separated by newlines or commas.
 * Drops invalid or duplicate URLs and reports the count of invalid lines.
 */
export function parseTrackerList(input: string): ParsedTrackers {
  const tokens = input.split(/[\r\n,]+/)
  const valid: string[] = []
  const seen = new Set<string>()
  let invalidCount = 0

  for (const token of tokens) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const normalized = normalizeTrackerUrl(trimmed)
    if (!normalized) {
      invalidCount++
      continue
    }
    if (!seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase())
      valid.push(normalized)
    }
  }

  return { valid, invalidCount }
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
