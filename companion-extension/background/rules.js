export const DEFAULT_EXTENSIONS = [
  // Archives & Disc Images
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'img', 'dmg', 'pkg',
  // Media & Video
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg',
  // Software & Installers
  'exe', 'msi', 'apk', 'deb', 'rpm', 'appimage', 'bin',
  // Documents & Data
  'pdf', 'epub', 'mobi', 'csv', 'dat', 'sql', 'sqlite', 'psd', 'raw', 'torrent'
]

export const NEVER_CAPTURE_EXTENSIONS = [
  'html', 'htm', 'php', 'asp', 'aspx', 'jsp',
  'js', 'mjs', 'css', 'json', 'svg', 'xml', 'crx'
]

export const DEFAULT_SETTINGS = {
  enabled: true,
  port: 41829,
  captureMode: 'extension_list', // 'extension_list' | 'all'
  extensions: DEFAULT_EXTENSIONS,
  excludedDomains: ['google.com/document', 'docs.google.com'],
  minSizeMb: 0
}

/**
 * Extracts a suggested filename from a URL or file path.
 */
export function extractFilename(filenameOrUrl) {
  if (!filenameOrUrl) return ''
  try {
    if (filenameOrUrl.includes('?')) {
      const query = filenameOrUrl.split('?')[1].split('#')[0]
      const match = query.match(/(?:filename|file|name|attachment)=([^&]+)/i)
      if (match) {
        const decoded = decodeURIComponent(match[1])
        const clean = decoded.split(/[/\\]/).filter(Boolean).pop() || ''
        if (clean) return clean
      }
    }
    const clean = filenameOrUrl.split('?')[0].split('#')[0]
    const parts = clean.split(/[/\\]/).filter(Boolean)
    const last = parts.pop() || ''
    if (/\.[a-zA-Z0-9]+$/.test(last)) {
      return decodeURIComponent(last)
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/\.[a-zA-Z0-9]+$/.test(parts[i])) {
        return decodeURIComponent(parts[i])
      }
    }
    return last ? decodeURIComponent(last) : ''
  } catch {
    return ''
  }
}

/**
 * Extracts the file extension from a file path or URL string.
 */
export function extractExtension(filenameOrUrl) {
  if (!filenameOrUrl) return ''
  try {
    if (filenameOrUrl.includes('?')) {
      const query = filenameOrUrl.split('?')[1].split('#')[0]
      const match = query.match(/(?:filename|file|name|attachment)=([^&]+)/i)
      if (match) {
        const decoded = decodeURIComponent(match[1])
        const ext = extractExtension(decoded)
        if (ext) return ext
      }
    }
    const clean = filenameOrUrl.split('?')[0].split('#')[0]
    const parts = clean.split(/[/\\]/).filter(Boolean)
    const lastPart = parts.pop() || ''
    const extMatch = lastPart.match(/\.([a-zA-Z0-9]+)$/)
    if (extMatch) return extMatch[1].toLowerCase()

    for (let i = parts.length - 1; i >= 0; i--) {
      const match = parts[i].match(/\.([a-zA-Z0-9]+)$/)
      if (match) {
        const candidate = match[1].toLowerCase()
        if (DEFAULT_EXTENSIONS.includes(candidate)) {
          return candidate
        }
      }
    }
    return ''
  } catch {
    return ''
  }
}

/**
 * Determines whether a downloadItem should be intercepted based on rules and settings.
 */
export function shouldCaptureDownload(downloadItem, settings) {
  if (!settings.enabled) return false

  const url = downloadItem.url || downloadItem.finalUrl
  if (!url) return false

  // Only intercept HTTP and HTTPS downloads
  if (!/^https?:/i.test(url)) return false

  // Check domain and path exclusions
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase()
    const fullHostAndPath = `${hostname}${parsed.pathname}`.toLowerCase()
    for (const domain of settings.excludedDomains || []) {
      const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
      if (!clean) continue
      if (clean.includes('/')) {
        if (fullHostAndPath.startsWith(clean)) return false
      } else {
        if (hostname === clean || hostname.endsWith(`.${clean}`)) return false
      }
    }
  } catch {
    return false
  }

  const ext =
    extractExtension(downloadItem.filename) ||
    extractExtension(downloadItem.finalUrl) ||
    extractExtension(url)

  // Never capture web source or browser extensions
  if (NEVER_CAPTURE_EXTENSIONS.includes(ext)) {
    return false
  }

  // Size threshold check if fileSize is known (> 0)
  if (settings.minSizeMb > 0 && downloadItem.fileSize > 0) {
    const minBytes = settings.minSizeMb * 1024 * 1024
    if (downloadItem.fileSize < minBytes) {
      return false
    }
  }

  if (settings.captureMode === 'all') {
    return true
  }

  // Default mode: check if extension is in list
  if (ext) {
    const allowed = (settings.extensions || DEFAULT_EXTENSIONS).map((e) => e.toLowerCase().trim())
    return allowed.includes(ext)
  }

  // If mime type indicates a downloadable archive/binary/media
  const mime = (downloadItem.mime || '').toLowerCase()
  if (
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime.includes('zip') ||
    mime.includes('tar') ||
    mime.includes('compressed') ||
    mime.includes('octet-stream') ||
    mime.includes('iso')
  ) {
    return true
  }

  // If no extension is detected (e.g. dynamic URL), and fileSize is sufficiently large (> 10 MB), capture it
  if (downloadItem.fileSize && downloadItem.fileSize > 10 * 1024 * 1024) {
    return true
  }

  return false
}
