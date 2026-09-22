import fc from 'fast-check'
import type { DownloadStatus } from '../src/shared/types'
import {
  BLOCK,
  checkEvents,
  checkFinalState,
  expect,
  LAN_ADDRESS,
  makeDirs,
  PlexoApp,
  test
} from './fixtures'
import { Origin, type Fault } from './origin'

// H. Model-based chaos. fast-check generates random sequences of user actions and failures —
// pause, resume, crash, quit, flaky server, waiting — and runs each against a real app and a
// throttled server. The property: whatever the sequence, once the faults stop and the download
// is resumed it completes with the exact bytes, and every event along the way obeyed the
// invariants. When a sequence fails, fast-check shrinks it to the shortest one that still
// fails and prints its seed; rerun that exact case with PLEXO_CHAOS_SEED=<seed>.
//
// PLEXO_CHAOS_RUNS sets how many sequences to try (default 5; nightly runs more).

const RUNS = Number(process.env.PLEXO_CHAOS_RUNS ?? 5)
const SEED = process.env.PLEXO_CHAOS_SEED ? Number(process.env.PLEXO_CHAOS_SEED) : undefined
const SIZE = 48 * BLOCK

interface Model {
  /** What the app should be doing, as far as the commands so far can tell. */
  phase: 'running' | 'paused' | 'done'
}

interface Real {
  app: PlexoApp
  origin: Origin
  id: string
  /** Faults still to hand out, one per chunk request. */
  faults: Fault[]
}

async function status(real: Real): Promise<DownloadStatus | undefined> {
  return (await real.app.current())?.status
}

/** Re-reads the app, since a running download may have finished on its own since last looked. */
async function sync(model: Model, real: Real): Promise<void> {
  const current = await status(real)
  if (current === 'completed' || current === 'assembling') model.phase = 'done'
  if (current === 'error' || current === 'cancelled') {
    throw new Error(`download ended ${current}: ${(await real.app.current())?.error}`)
  }
}

class Wait implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ms: number) {}
  check = (): boolean => true
  async run(model: Model, real: Real): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.ms))
    await sync(model, real)
  }
  toString = (): string => `Wait(${this.ms})`
}

class Pause implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>): boolean => model.phase === 'running'
  async run(model: Model, real: Real): Promise<void> {
    await real.app.api.pauseDownload(real.id)
    // Either it paused, or it had already finished downloading before the pause arrived.
    const state = await real.app.waitForStatus(['paused', 'assembling', 'completed'], 15_000)
    model.phase = state.status === 'paused' ? 'paused' : 'done'
  }
  toString = (): string => 'Pause'
}

class Resume implements fc.AsyncCommand<Model, Real> {
  check = (model: Readonly<Model>): boolean => model.phase === 'paused'
  async run(model: Model, real: Real): Promise<void> {
    await real.app.api.resumeDownload(real.id)
    await real.app.waitForStatus(['downloading', 'assembling', 'completed'], 15_000)
    model.phase = 'running'
    await sync(model, real)
  }
  toString = (): string => 'Resume'
}

class Restart implements fc.AsyncCommand<Model, Real> {
  constructor(readonly how: 'crash' | 'quit') {}
  check = (): boolean => true
  async run(model: Model, real: Real): Promise<void> {
    await sync(model, real)
    if (this.how === 'crash') await real.app.kill()
    else await real.app.quit()
    await real.app.launch()

    const state = await real.app.current()
    expect(state?.id, 'the download survives the restart').toBe(real.id)
    // Anything unfinished comes back paused; one that finished (possibly in the instant between
    // the last look and the kill) stays completed — the final byte check covers that case.
    expect(['paused', 'completed'], `status after ${this.how}`).toContain(state?.status)
    model.phase = state?.status === 'completed' ? 'done' : 'paused'
  }
  toString = (): string => (this.how === 'crash' ? 'Crash' : 'Quit')
}

class Flaky implements fc.AsyncCommand<Model, Real> {
  constructor(readonly faults: Fault[]) {}
  check = (): boolean => true
  async run(_model: Model, real: Real): Promise<void> {
    // Replaces rather than adds, so faults never pile up past what the retry budget absorbs.
    real.faults = [...this.faults]
  }
  toString = (): string => `Flaky(${JSON.stringify(this.faults)})`
}

const faultArb: fc.Arbitrary<Fault> = fc.oneof(
  fc.integer({ min: 0, max: BLOCK - 1 }).map((cutAfter): Fault => ({ cutAfter })),
  fc.constant<Fault>({ status: 500 }),
  fc.constant<Fault>({ status: 503 }),
  fc.constant<Fault>('wrongStart'),
  fc.constant<Fault>('overlong'),
  fc.integer({ min: 0, max: BLOCK - 1 }).map((endAfter): Fault => ({ endAfter }))
)

const commands = fc.commands(
  [
    fc.integer({ min: 20, max: 700 }).map((ms) => new Wait(ms)),
    fc.constant(new Pause()),
    fc.constant(new Resume()),
    fc.constantFrom('crash' as const, 'quit' as const).map((how) => new Restart(how)),
    fc.array(faultArb, { minLength: 1, maxLength: 3 }).map((faults) => new Flaky(faults))
  ],
  { maxCommands: 12 }
)

test('any sequence of pauses, crashes and faults still ends in the exact file @chaos', async () => {
  test.setTimeout(RUNS * 90_000 + 60_000)

  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 2 ** 31 - 1 }),
      fc.integer({ min: 1, max: 4 }),
      commands,
      async (fileSeed, connections, cmds) => {
        const { dirs, dispose } = await makeDirs()
        const origin = await new Origin({
          size: SIZE,
          seed: fileSeed,
          bytesPerSecond: 512 * 1024
        }).start()
        const app = new PlexoApp(dirs)
        const real: Real = { app, origin, id: '', faults: [] }
        origin.setRule(({ range }) =>
          range && !(range.start === 0 && range.end === 0) ? real.faults.shift() : undefined
        )

        try {
          await app.launch()
          real.id = await app.start(origin.url(), origin.sha256, {
            networks: LAN_ADDRESS ? ['a', 'b'] : ['a'],
            connections
          })
          await fc.asyncModelRun(() => ({ model: { phase: 'running' } as Model, real }), cmds)

          // Faults off, let it finish, then hold it to every rule.
          real.faults = []
          if ((await status(real)) === 'paused') await app.api.resumeDownload(real.id)
          await app.waitForStatus('completed', 60_000)
          checkEvents(app.sessions)
          await checkFinalState(app)
        } finally {
          if (app.alive) await app.kill().catch(() => {})
          await origin.stop()
          await dispose()
        }
      }
    ),
    { numRuns: RUNS, seed: SEED, verbose: 1, interruptAfterTimeLimit: RUNS * 90_000 }
  )
})
