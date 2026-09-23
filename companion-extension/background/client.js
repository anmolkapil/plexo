/**
 * HTTP Client for communicating with the Plexo Desktop loopback server.
 */

export async function checkPlexoHealth(port = 41829) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1200)
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!res.ok) return { online: false }
    const data = await res.json()
    return { online: true, ...data }
  } catch {
    return { online: false }
  }
}

export async function sendDownloadToPlexo(payload, port = 41829) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)

  try {
    const res = await fetch(`http://127.0.0.1:${port}/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
    clearTimeout(timer)

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      return { success: false, error: err.error || `HTTP ${res.status}` }
    }

    const data = await res.json()
    return { success: true, ...data }
  } catch (error) {
    clearTimeout(timer)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Could not connect to Plexo'
    }
  }
}

/**
 * Converts an array of chrome.cookies.Cookie objects into a standard HTTP Cookie header string.
 */
export function formatCookies(cookieList) {
  if (!Array.isArray(cookieList) || cookieList.length === 0) return ''
  return cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
}
