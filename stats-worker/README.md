# Plexo stats Worker

Receives the app's anonymous usage and error stats (`src/main/stats.ts`) and stores them in
[Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/). What may be
sent is listed in `src/shared/stats.ts`; this Worker checks every event against that same list and
drops anything else. It never reads the request's IP address, and request logs are off. The public
description is `docs/privacy/index.html` (getplexo.app/privacy).

Until a release is built with `PLEXO_STATS_URL` set, the app sends nothing.

## Deploy

1. From this folder, on the Cloudflare account that has getplexo.app:

   ```sh
   npm install
   npx wrangler login
   npx wrangler deploy
   ```

   The Analytics Engine dataset `plexo_events` is created on its first write.

2. Route it under the site, so the app talks to getplexo.app only: in the dashboard, Workers →
   plexo-stats → Settings → Domains & Routes → add route `getplexo.app/api/events`. (Or keep the
   `*.workers.dev` URL.)

3. In the GitHub repo: Settings → Secrets and variables → Actions → Variables → add
   `PLEXO_STATS_URL` = `https://getplexo.app/api/events`. The release workflow passes it to the build.

Try it with a fake batch:

```sh
curl -i https://getplexo.app/api/events -H 'content-type: application/json' -d '{
  "install_id": "3f1c2b9e-7a1d-4c3e-9b2a-5d6e7f8a9b0c", "app_version": "1.0.0", "os": "darwin",
  "os_version": "15", "arch": "arm64", "lang": "en-US",
  "events": [{ "name": "update_failed", "props": { "error_class": "tls" } }] }'
```

It answers `204`, or `400` for anything not on the list.

## Layout

One data point per event:

| Column          | Holds                                                         |
| --------------- | ------------------------------------------------------------- |
| `index1`        | install id                                                    |
| `blob1`         | event name                                                    |
| `blob2`–`blob6` | app version, OS, OS major version, CPU architecture, language |
| `blob7` on      | the event's fields, in the order `STATS_EVENTS` lists them    |

So for `download_failed`, `blob7`–`blob11` are type, error_class, http_status, done, networks.
Analytics Engine keeps data for three months.

## Queries

Run with the [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
(`_sample_interval` accounts for sampling):

```sql
-- Why downloads fail, last 7 days
SELECT blob8 AS error_class, SUM(_sample_interval) AS failures
FROM plexo_events
WHERE blob1 = 'download_failed' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY error_class ORDER BY failures DESC

-- Finished vs failed, by OS and version
SELECT blob3 AS os, blob2 AS version, blob1 AS event, SUM(_sample_interval) AS n
FROM plexo_events
WHERE blob1 IN ('download_finished', 'download_failed') AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY os, version, event ORDER BY os, version

-- Which networks people combine
SELECT blob11 AS networks, SUM(_sample_interval) AS downloads
FROM plexo_events
WHERE blob1 = 'download_finished' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY networks ORDER BY downloads DESC

-- Errors in the app, grouped by where they're thrown
SELECT blob7 AS process, blob8 AS name, blob10 AS frames, blob2 AS version,
  SUM(_sample_interval) AS n
FROM plexo_events
WHERE blob1 = 'app_error' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY process, name, frames, version ORDER BY n DESC
```
