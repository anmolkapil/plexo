import {
  STATS_EVENTS,
  validStatsBatch,
  validStatsEvent,
  type StatsField
} from '../../src/shared/stats'

/**
 * Receives Plexo's anonymous usage and error stats (src/main/stats.ts) and writes each event to
 * Workers Analytics Engine. Every batch and event is checked against the list in
 * src/shared/stats.ts, the same list the app builds them from and docs/privacy/index.html
 * describes: an event that isn't on it, or has a field that isn't, is dropped. The request's IP
 * address is never read or stored.
 *
 * One data point per event:
 * - index1: the install id (so counts can be per install, and sampling keeps an install whole)
 * - blob1: event name; blob2–6: app_version, os, os_version, arch, lang
 * - blob7 on: the event's fields, in the order STATS_EVENTS lists them
 */

interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void
}

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface Env {
  EVENTS: AnalyticsEngineDataset
  LIMITER?: RateLimit
}

/** A full batch of 100 events is about 25 KB. */
const MAX_BODY_BYTES = 64 * 1024

const empty = (status: number): Response => new Response(null, { status })

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') return empty(405)
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return empty(413)
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) return empty(413)

    let batch: unknown
    try {
      batch = JSON.parse(text)
    } catch {
      return empty(400)
    }
    if (!validStatsBatch(batch)) return empty(400)

    // Per install, never per address.
    if (env.LIMITER && !(await env.LIMITER.limit({ key: batch.install_id })).success) {
      return empty(429)
    }

    for (const event of batch.events) {
      if (!validStatsEvent(event)) continue
      const fields: readonly StatsField[] = STATS_EVENTS[event.name]
      const props = event.props as Record<string, string>
      env.EVENTS.writeDataPoint({
        indexes: [batch.install_id],
        blobs: [
          event.name,
          batch.app_version,
          batch.os,
          batch.os_version,
          batch.arch,
          batch.lang,
          ...fields.map((field) => props[field])
        ]
      })
    }
    return empty(204)
  }
}
