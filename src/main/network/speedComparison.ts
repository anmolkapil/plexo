import { URL } from 'node:url'
import type {
  CombinedSpeedResult,
  InterfaceSpeedResult,
  NetworkInterfaceInfo,
  SpeedComparisonProgress,
  SpeedComparisonReport
} from '../../shared/types'
export const DEFAULT_SPEED_TEST_URL = 'https://speed.cloudflare.com/__down?bytes=50000000'
export const DEFAULT_WARMUP_MS = 1500
export const DEFAULT_MEASURE_MS = 3500
export const TOTAL_STREAMS = 4

export interface SpeedTestConnection {
  request: (
    target: URL,
    headers: Record<string, string>,
    signal?: AbortSignal
  ) => Promise<{
    res: {
      on: (event: string, cb: (...args: unknown[]) => void) => void
      once: (event: string, cb: (...args: unknown[]) => void) => void
      destroy: () => void
    }
  }>
  close: () => void
}

export type ConnectionFactory = (
  iface: NetworkInterfaceInfo,
  timeoutMs: number
) => Promise<SpeedTestConnection> | SpeedTestConnection

let customConnectionFactory: ConnectionFactory | null = null

export function setConnectionFactory(factory: ConnectionFactory | null): void {
  customConnectionFactory = factory
}

async function createConnection(
  iface: NetworkInterfaceInfo,
  timeoutMs = 8000
): Promise<SpeedTestConnection> {
  if (customConnectionFactory) {
    return customConnectionFactory(iface, timeoutMs)
  }
  const { StreamConnection } = await import('./routes')
  return new StreamConnection(() => iface, { timeoutMs, connectTimeoutMs: 6000 })
}

export function calculateStreamAllocations(
  interfaces: NetworkInterfaceInfo[],
  totalStreams = TOTAL_STREAMS
): { iface: NetworkInterfaceInfo; streams: number }[] {
  if (interfaces.length === 0) return []
  if (interfaces.length >= totalStreams) {
    return interfaces.map((iface) => ({ iface, streams: 1 }))
  }
  const base = Math.floor(totalStreams / interfaces.length)
  let remainder = totalStreams % interfaces.length
  return interfaces.map((iface) => {
    const count = base + (remainder > 0 ? 1 : 0)
    if (remainder > 0) remainder--
    return { iface, streams: count }
  })
}

export function calculateSpeedup(
  combinedSpeed: number,
  individualSpeeds: number[]
): { fastest: number; multiplier: number; percent: number } {
  const fastest = individualSpeeds.length > 0 ? Math.max(...individualSpeeds, 0) : 0
  if (fastest <= 0) {
    return { fastest: 0, multiplier: 1, percent: 0 }
  }
  const multiplier = Number((combinedSpeed / fastest).toFixed(2))
  const percent = Math.round(((combinedSpeed - fastest) / fastest) * 100)
  return { fastest, multiplier, percent }
}

export function calculateContributions(
  bytesByInterface: Record<string, number>
): Record<string, { bytes: number; percent: number }> {
  const total = Object.values(bytesByInterface).reduce((sum, b) => sum + b, 0)
  const result: Record<string, { bytes: number; percent: number }> = {}
  for (const [id, bytes] of Object.entries(bytesByInterface)) {
    const percent = total > 0 ? Math.round((bytes / total) * 100) : 0
    result[id] = { bytes, percent }
  }
  return result
}

export function assessComparison(
  reachableCount: number,
  speedupMultiplier?: number
): { assessment: SpeedComparisonReport['assessment']; note: string } {
  if (reachableCount <= 0) {
    return {
      assessment: 'failed',
      note: 'None of the selected networks were able to connect to the test server.'
    }
  }
  if (reachableCount === 1) {
    return {
      assessment: 'single_network',
      note: 'Only one working network was tested. Connect and select a second network (e.g. phone USB tether) to compare combined acceleration.'
    }
  }
  if (speedupMultiplier === undefined) {
    return {
      assessment: 'failed',
      note: 'Combined speed test could not be evaluated.'
    }
  }
  if (speedupMultiplier >= 1.25) {
    return {
      assessment: 'significant_gain',
      note: `Strong acceleration (${speedupMultiplier}×): Your connections provide independent uplinks, enabling Plexo to deliver a substantial speed boost.`
    }
  }
  if (speedupMultiplier >= 1.05) {
    return {
      assessment: 'moderate_gain',
      note: `Moderate speed gain (${speedupMultiplier}×): Both networks contribute throughput, though one connection may be dominant or upstream overhead is present.`
    }
  }
  return {
    assessment: 'no_gain',
    note: `Similar throughput (${speedupMultiplier}×): Combined speed is nearly identical to your single fastest connection. The connections likely share the same local Wi-Fi router, cable modem, or ISP bottleneck.`
  }
}

interface StageExecutionResult {
  status: 'completed' | 'unreachable'
  speedBytesPerSec: number
  measuredBytesByInterface: Record<string, number>
  bytesUsed: number
  error?: string
}

async function runStage({
  stageIndex,
  totalStages,
  stageName,
  stageKind,
  allocations,
  testUrl,
  warmupMs,
  measureMs,
  signal,
  totalBytesRef,
  onProgress
}: {
  stageIndex: number
  totalStages: number
  stageName: string
  stageKind: 'individual' | 'combined'
  allocations: { iface: NetworkInterfaceInfo; streams: number }[]
  testUrl: string
  warmupMs: number
  measureMs: number
  signal: AbortSignal
  totalBytesRef: { value: number }
  onProgress: (progress: SpeedComparisonProgress) => void
}): Promise<StageExecutionResult> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  const stageController = new AbortController()
  const stageSignal = AbortSignal.any([signal, stageController.signal])
  const stageStart = Date.now()
  const totalDuration = warmupMs + measureMs

  let measuredBytes = 0
  let measureStart: number | null = null
  let isMeasuring = false
  const measuredBytesByInterface: Record<string, number> = {}
  let stageBytesUsed = 0

  const activeConnections: SpeedTestConnection[] = []
  const targetUrl = new URL(testUrl)
  let successfulChunks = 0
  const errors: Error[] = []

  // Launch parallel streams
  const streamPromises: Promise<void>[] = []
  for (const { iface, streams } of allocations) {
    for (let s = 0; s < streams; s++) {
      const streamWorker = (async () => {
        let conn: SpeedTestConnection
        try {
          conn = await createConnection(iface, 8000)
          activeConnections.push(conn)
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
          return
        }
        while (!stageSignal.aborted && Date.now() - stageStart < totalDuration) {
          try {
            const { res } = await conn.request(
              targetUrl,
              {
                'User-Agent': 'Plexo-SpeedTest/1.0',
                'Accept-Encoding': 'identity'
              },
              stageSignal
            )

            await new Promise<void>((resolve, reject) => {
              const onData = (chunk: unknown): void => {
                const len = Buffer.isBuffer(chunk)
                  ? chunk.length
                  : ((chunk as { length?: number })?.length ?? 0)
                successfulChunks++
                stageBytesUsed += len
                totalBytesRef.value += len

                if (isMeasuring) {
                  measuredBytes += len
                  measuredBytesByInterface[iface.id] =
                    (measuredBytesByInterface[iface.id] ?? 0) + len
                }
              }

              res.on('data', onData)
              res.once('end', () => resolve())
              res.once('error', (err) => reject(err))

              const abortHandler = (): void => {
                res.destroy()
                resolve()
              }
              stageSignal.addEventListener('abort', abortHandler, { once: true })
            })
          } catch (err) {
            if (!stageSignal.aborted) {
              errors.push(err instanceof Error ? err : new Error(String(err)))
            }
            break
          }
        }
      })()

      streamPromises.push(streamWorker)
    }
  }

  // Periodic progress timer
  const progressTimer = setInterval(() => {
    if (signal.aborted) return
    const elapsed = Date.now() - stageStart

    if (elapsed < warmupMs) {
      const percent = Math.min(99, Math.floor((elapsed / totalDuration) * 100))
      onProgress({
        stageIndex,
        totalStages,
        stageName,
        stageKind,
        phase: 'warming_up',
        percent,
        currentSpeedBytesPerSec: 0,
        totalBytesUsedSoFar: totalBytesRef.value
      })
    } else {
      isMeasuring = true
      measureStart ??= Date.now()
      const measuredElapsed = Math.max(1, Date.now() - measureStart)
      const currentSpeed = (measuredBytes * 1000) / measuredElapsed
      const percent = Math.min(99, Math.floor((elapsed / totalDuration) * 100))

      onProgress({
        stageIndex,
        totalStages,
        stageName,
        stageKind,
        phase: 'measuring',
        percent,
        currentSpeedBytesPerSec: currentSpeed,
        totalBytesUsedSoFar: totalBytesRef.value
      })
    }
  }, 200)

  // Sleep until stage completion or abort
  await new Promise<void>((resolve) => {
    const durationTimer = setTimeout(resolve, totalDuration)
    const onAbort = (): void => {
      clearTimeout(durationTimer)
      resolve()
    }
    stageSignal.addEventListener('abort', onAbort, { once: true })
  })

  // Cleanup stage
  stageController.abort()
  clearInterval(progressTimer)
  for (const conn of activeConnections) {
    conn.close()
  }
  await Promise.allSettled(streamPromises)

  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  if (successfulChunks === 0 && errors.length > 0) {
    return {
      status: 'unreachable',
      speedBytesPerSec: 0,
      measuredBytesByInterface: {},
      bytesUsed: stageBytesUsed,
      error: errors[0].message
    }
  }

  const finalMeasureDuration = measureStart
    ? Math.max(1, Date.now() - measureStart)
    : Math.max(1, measureMs)
  const finalSpeed = (measuredBytes * 1000) / finalMeasureDuration

  return {
    status: 'completed',
    speedBytesPerSec: finalSpeed,
    measuredBytesByInterface,
    bytesUsed: stageBytesUsed
  }
}

export async function runSpeedComparison({
  allInterfaces,
  selectedIds,
  testUrl = DEFAULT_SPEED_TEST_URL,
  warmupMs = DEFAULT_WARMUP_MS,
  measureMs = DEFAULT_MEASURE_MS,
  signal,
  onProgress
}: {
  allInterfaces: NetworkInterfaceInfo[]
  selectedIds?: string[]
  testUrl?: string
  warmupMs?: number
  measureMs?: number
  signal: AbortSignal
  onProgress: (progress: SpeedComparisonProgress) => void
}): Promise<SpeedComparisonReport> {
  const targetInterfaces =
    selectedIds && selectedIds.length > 0
      ? allInterfaces.filter((i) => selectedIds.includes(i.id))
      : allInterfaces

  if (targetInterfaces.length === 0) {
    return {
      timestamp: Date.now(),
      individualResults: [],
      totalBytesUsed: 0,
      assessment: 'failed',
      assessmentNote: 'No network interfaces selected for testing.'
    }
  }

  const individualStagesCount = targetInterfaces.length
  // Combined stage runs only if more than 1 interface is selected
  const totalStages = individualStagesCount > 1 ? individualStagesCount + 1 : 1
  const totalBytesRef = { value: 0 }
  const individualResults: InterfaceSpeedResult[] = []

  // 1. Measure each interface individually
  for (let i = 0; i < targetInterfaces.length; i++) {
    const iface = targetInterfaces[i]
    const allocations = [{ iface, streams: TOTAL_STREAMS }]

    const result = await runStage({
      stageIndex: i + 1,
      totalStages,
      stageName: iface.displayName,
      stageKind: 'individual',
      allocations,
      testUrl,
      warmupMs,
      measureMs,
      signal,
      totalBytesRef,
      onProgress
    })

    individualResults.push({
      interfaceId: iface.id,
      interfaceName: iface.displayName,
      status: result.status,
      speedBytesPerSec: result.speedBytesPerSec,
      bytesUsed: result.bytesUsed,
      error: result.error
    })
  }

  const workingInterfaces = targetInterfaces.filter((iface) => {
    const res = individualResults.find((r) => r.interfaceId === iface.id)
    return res && res.status === 'completed' && res.speedBytesPerSec > 0
  })

  // 2. Measure combined if 2 or more working interfaces
  let combinedResult: CombinedSpeedResult | undefined = undefined
  if (workingInterfaces.length >= 2) {
    const allocations = calculateStreamAllocations(workingInterfaces, TOTAL_STREAMS)

    const stageResult = await runStage({
      stageIndex: totalStages,
      totalStages,
      stageName: 'Combined (All Working Networks)',
      stageKind: 'combined',
      allocations,
      testUrl,
      warmupMs,
      measureMs,
      signal,
      totalBytesRef,
      onProgress
    })

    combinedResult = {
      speedBytesPerSec: stageResult.speedBytesPerSec,
      bytesUsed: stageResult.bytesUsed,
      contributions: calculateContributions(stageResult.measuredBytesByInterface)
    }
  }

  // Calculate comparative metrics
  const completedIndividuals = individualResults.filter((r) => r.status === 'completed')
  let fastestIndividual: SpeedComparisonReport['fastestIndividual'] = undefined
  let speedupMultiplier: number | undefined = undefined
  let speedupPercent: number | undefined = undefined

  if (completedIndividuals.length > 0) {
    const fastest = completedIndividuals.reduce((prev, curr) =>
      curr.speedBytesPerSec > prev.speedBytesPerSec ? curr : prev
    )
    fastestIndividual = {
      interfaceId: fastest.interfaceId,
      interfaceName: fastest.interfaceName,
      speedBytesPerSec: fastest.speedBytesPerSec
    }

    if (combinedResult) {
      const stats = calculateSpeedup(
        combinedResult.speedBytesPerSec,
        completedIndividuals.map((r) => r.speedBytesPerSec)
      )
      speedupMultiplier = stats.multiplier
      speedupPercent = stats.percent
    }
  }

  const { assessment, note } = assessComparison(workingInterfaces.length, speedupMultiplier)

  return {
    timestamp: Date.now(),
    individualResults,
    combinedResult,
    fastestIndividual,
    speedupMultiplier,
    speedupPercent,
    totalBytesUsed: totalBytesRef.value,
    assessment,
    assessmentNote: note
  }
}

export class SpeedComparisonManager {
  private inFlight: {
    abortController: AbortController
    promise: Promise<SpeedComparisonReport>
  } | null = null

  async start(
    allInterfaces: NetworkInterfaceInfo[],
    selectedIds: string[] | undefined,
    onProgress: (progress: SpeedComparisonProgress) => void
  ): Promise<SpeedComparisonReport> {
    if (this.inFlight) {
      this.inFlight.abortController.abort()
      this.inFlight = null
    }

    const abortController = new AbortController()
    const promise = runSpeedComparison({
      allInterfaces,
      selectedIds,
      signal: abortController.signal,
      onProgress
    }).finally(() => {
      if (this.inFlight?.abortController === abortController) {
        this.inFlight = null
      }
    })

    this.inFlight = { abortController, promise }
    return promise
  }

  cancel(): void {
    if (this.inFlight) {
      this.inFlight.abortController.abort()
      this.inFlight = null
    }
  }
}
