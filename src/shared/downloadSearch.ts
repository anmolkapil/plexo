/**
 * Normalizes a search query by trimming whitespace and normalizing Unicode (NFC).
 */
export function normalizeSearchQuery(query: string): string {
  return query.trim().normalize('NFC').toLowerCase()
}

/**
 * Checks whether a download item matches a search query.
 * Matches case-insensitively across fileName and url.
 * Multiple space-separated keywords must all match (AND search).
 * An empty or whitespace-only query matches all items.
 */
export function matchesSearch(item: { fileName: string; url?: string }, query: string): boolean {
  const normalized = normalizeSearchQuery(query)
  if (!normalized) return true

  const tokens = normalized.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true

  const name = item.fileName.normalize('NFC').toLowerCase()
  const url = (item.url ?? '').normalize('NFC').toLowerCase()
  const haystack = `${name} ${url}`

  return tokens.every((token) => haystack.includes(token))
}

/**
 * Filters an array of download items against a search query.
 */
export function filterDownloadsByQuery<T extends { fileName: string; url?: string }>(
  items: readonly T[],
  query: string
): T[] {
  if (!query.trim()) return [...items]
  return items.filter((item) => matchesSearch(item, query))
}
