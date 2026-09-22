import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { NetworkInterfaceInfo, SimulatedNetworkConfig } from '../../shared/types'
import type { ChunkDownloadOptions } from './chunkDownloader'

/** Marks a download as sourced from a local file rather than the network — the rest of
 * `DownloadManager` treats `requestPayload.url` as opaque, so this prefix is the only thing
 * that has to recognize a simulated download and route it to `downloadChunkSimulated` instead
 * of the real HTTP `downloadChunk`. */
const SIM_URL_PREFIX = 'plexo-sim://'

export function isSimulatedUrl(url: string): boolean {
  return url.startsWith(SIM_URL_PREFIX)
}

interface SimSession {
  sourcePath: string
  /** Keyed by the synthetic NetworkInterfaceInfo.id assigned to each simulated network. */
  networks: Map<string, SimulatedNetworkConfig>
  /** bytes/sec to throttle reassembly to, or null to assemble at full disk speed. */
  assembleSpeedBytesPerSec: number | null
}

const sessions = new Map<string, SimSession>()

/** Registers one dev-tool "virtual download" run and returns the `plexo-sim://<token>` url to
 * use as its `StartDownloadRequest.url` — everything downstream (blocks, chunks, persistence,
 * the assembling phase) is unaware this isn't a real network transfer. */
function registerSimSession(
  sourcePath: string,
  networks: Map<string, SimulatedNetworkConfig>,
  assembleSpeedBytesPerSec: number | null
): string {
  const token = randomUUID()
  sessions.set(token, { sourcePath, networks, assembleSpeedBytesPerSec })
  return token
}

export function unregisterSimSession(url: string): void {
  if (!isSimulatedUrl(url)) return
  sessions.delete(url.slice(SIM_URL_PREFIX.length))
}

/** How slowly `DownloadManager.reassemble()` should stitch this simulated download's part
 * files together, or null when it isn't simulated (or wasn't given an assemble speed) and
 * should run at full disk speed as usual. */
export function getSimAssembleSpeed(url: string): number | null {
  if (!isSimulatedUrl(url)) return null
  return sessions.get(url.slice(SIM_URL_PREFIX.length))?.assembleSpeedBytesPerSec ?? null
}

/** Builds the synthetic interfaces + registers the sim session a `StartDownloadRequest` needs
 * to drive a simulated download through the normal `DownloadManager.start()` path. */
export async function createSimSession(
  sourceFilePath: string,
  networkConfigs: SimulatedNetworkConfig[],
  assembleSpeedBytesPerSec: number | null
): Promise<{ url: string; interfaces: NetworkInterfaceInfo[]; totalBytes: number }> {
  const fileStat = await stat(sourceFilePath)
  const networks = new Map<string, SimulatedNetworkConfig>()
  const interfaces: NetworkInterfaceInfo[] = networkConfigs.map((config, index) => {
    const id = `sim-${index}-${randomUUID().slice(0, 8)}`
    networks.set(id, config)
    return {
      id,
      device: id,
      displayName: config.label,
      address: id,
      kind: config.kind
    }
  })

  const token = registerSimSession(sourceFilePath, networks, assembleSpeedBytesPerSec)
  return { url: `${SIM_URL_PREFIX}${token}`, interfaces, totalBytes: fileStat.size }
}

const DEFAULT_SPEED_BYTES_PER_SEC = 3 * 1024 * 1024

/** Local-file stand-in for `downloadChunk()` — same contract (resolves only once the exact
 * byte range is written to `destinationPath`, honors `signal`, calls `onProgress` with
 * cumulative bytes) so `DownloadManager` can swap one for the other without knowing which one
 * it's running. Reads the requested range off disk instead of over HTTP, throttled to the
 * simulated network's configured speed so the UI has something real to show — a chunk grid or
 * speed readout that jumped from 0 to 100% instantly would defeat the point of simulating it. */
export function downloadChunkSimulated(options: ChunkDownloadOptions): Promise<void> {
  const { url, rangeStart, rangeEnd, localAddress, destinationPath, append, onProgress, signal } =
    options

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }

    const session = sessions.get(url.slice(SIM_URL_PREFIX.length))
    if (!session) {
      reject(new Error('Simulated download session no longer exists (was the dev tool closed?)'))
      return
    }

    const network = session.networks.get(localAddress)
    if (network && Math.random() * 100 < network.faultRatePercent) {
      reject(new Error(`Simulated drop on ${network.label}`))
      return
    }
    const speedBytesPerSec = network?.speedBytesPerSec ?? DEFAULT_SPEED_BYTES_PER_SEC

    const expectedBytes = rangeEnd === null ? null : rangeEnd - rangeStart + 1
    const input = createReadStream(session.sourcePath, {
      start: rangeStart,
      end: rangeEnd ?? undefined
    })
    const output = createWriteStream(destinationPath, { flags: append ? 'a' : 'w' })

    let bytesWritten = 0
    let settled = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const fail = (error: Error): void =>
      settle(() => {
        input.destroy()
        output.destroy()
        reject(error)
      })
    const onAbort = (): void => fail(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort)

    input.on('error', fail)
    output.on('error', fail)

    input.on('data', (chunk: string | Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      // Pausing the source for a delay proportional to this chunk's size — rather than writing
      // everything Node hands us as fast as disk I/O allows — is what makes the simulated speed
      // real: a real download is limited by the network, so the block grid and speed readout
      // should move at a rate this slow, not spike and then sit idle.
      input.pause()
      const delayMs = Math.max(1, (buffer.length / speedBytesPerSec) * 1000)
      setTimeout(() => {
        if (settled) return
        output.write(buffer)
        bytesWritten += buffer.length
        onProgress(bytesWritten)
        input.resume()
      }, delayMs)
    })

    input.on('end', () => output.end())
    output.on('finish', () => {
      if (expectedBytes !== null && bytesWritten !== expectedBytes) {
        fail(new Error(`Simulated chunk wrote ${bytesWritten} bytes but expected ${expectedBytes}`))
        return
      }
      settle(resolve)
    })
  })
}
