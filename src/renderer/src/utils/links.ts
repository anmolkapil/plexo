export interface ParsedLinks {
  /** Every http(s) link found, in order, each once. */
  urls: string[]
  /** Links that appeared more than once in the text. */
  repeated: number
  /** Non-empty lines with no link on them. */
  unreadable: number
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi

/** The links in pasted text: one per line as a rule, but any whitespace (or a list copied out of
 * a browser or JDownloader, with names around them) works too. */
export function parseLinks(text: string): ParsedLinks {
  const urls: string[] = []
  const seen = new Set<string>()
  let repeated = 0
  let unreadable = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const found = line.match(URL_PATTERN) ?? []
    let usable = 0
    for (const candidate of found) {
      // Trailing punctuation from prose ("see https://x.y/file.zip.") isn't part of the link.
      const trimmed = candidate.replace(/[),.;:!?\]]+$/, '')
      let url: string
      try {
        url = new URL(trimmed).toString()
      } catch {
        continue
      }
      usable++
      if (seen.has(url)) {
        repeated++
        continue
      }
      seen.add(url)
      urls.push(url)
    }
    if (usable === 0) unreadable++
  }
  return { urls, repeated, unreadable }
}

/** Whether pasted text holds more than one link — a batch for the queue, not one download. */
export function isBatch(text: string): boolean {
  return parseLinks(text).urls.length > 1
}
