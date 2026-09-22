import { net } from 'electron'
import type { UpdateInfo } from '../shared/types'

type ReleaseInfo = Omit<UpdateInfo, 'dismissed'>

const REPO = 'anmolkapil/plexo'
export const UPDATE_PAGE_URL = 'https://anmolkapil.github.io/plexo/'

function parseVersion(version: string): number[] {
  // ponytail: naive numeric-segment compare, not full semver (a "1.0.0-rc.2" pre-release tag
  // reads as a plain 4th segment) — swap for the `semver` package if pre-release ordering ever
  // needs to be exact.
  return version
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((part) => parseInt(part, 10) || 0)
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Checks the repo's latest GitHub release against the running app version. Same data source the
 * landing page's downloads list already reads, so there's no separate update feed to stand up.
 *
 * Uses the releases list rather than the `/releases/latest` endpoint: every release here ships
 * as a pre-release, and GitHub's "latest" endpoint only ever considers non-prerelease releases —
 * it 404s when there isn't one, so it would never surface an update. */
export async function checkForUpdate(currentVersion: string): Promise<ReleaseInfo | null> {
  try {
    const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`)
    if (!response.ok) return null
    const [data] = (await response.json()) as { tag_name?: string }[]
    if (!data?.tag_name) return null
    const version = data.tag_name.replace(/^v/, '')
    if (!isNewer(version, currentVersion)) return null
    return { version, url: UPDATE_PAGE_URL }
  } catch {
    // Offline, rate-limited, or GitHub is down — silently skip the notification rather than
    // surface a startup error for a non-essential check.
    return null
  }
}
