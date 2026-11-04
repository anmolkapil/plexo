import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readdir, rm } from 'node:fs/promises'
import { delimiter, join, relative, sep } from 'node:path'
import type { NzbPostProcess } from '../../../shared/types'

/** Where the tools are looked for: PATH, then where their installers put them without adding
 * them to it (7-Zip's and WinRAR's on Windows; Homebrew's, which an app opened from the Finder
 * doesn't have on its PATH). */
function toolDirs(): string[] {
  const path = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  if (process.platform === 'darwin') return [...path, '/opt/homebrew/bin', '/usr/local/bin']
  if (process.platform !== 'win32') return path
  const programs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
  return [
    ...path,
    ...programs.flatMap((dir) => (dir ? [join(dir, '7-Zip'), join(dir, 'WinRAR')] : []))
  ]
}

/** `name` as installed, a path to run; null when it isn't. */
export async function findTool(name: string): Promise<string | null> {
  const file = process.platform === 'win32' ? `${name}.exe` : name
  for (const dir of toolDirs()) {
    const path = join(dir, file)
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false
      )
    )
      return path
  }
  return null
}

/** The last percentage in what a tool printed: par2, 7-Zip and unrar all count up in place. */
export function percentIn(text: string): number | undefined {
  const last = [...text.matchAll(/(\d{1,3})(?:\.\d+)?%/g)].at(-1)
  return last ? Math.min(100, Number(last[1])) : undefined
}

/** The last line a tool printed that says anything: what it failed on. */
function lastLine(output: string): string {
  return (
    output
      .split(/[\r\n\b]+/)
      .map((line) => line.trim())
      .filter((line) => line && !line.includes('%'))
      .at(-1) ?? 'no output'
  )
}

/** Runs `tool` in `cwd` with `args` as they are, never through a shell: file names come from the
 * NZB. What it prints goes to `onOutput` as it comes; aborting `signal` kills it. */
function runTool(
  tool: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onOutput: (text: string) => void
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let output = ''
    const take = (chunk: Buffer): void => {
      const text = chunk.toString()
      output = (output + text).slice(-16_384)
      onOutput(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

/** What can unpack what, best first. 7-Zip opens RAR too, where its build has the codec; unar
 * opens everything, but can't tell a wrong password from damage. */
const UNPACKERS: {
  name: string
  opens: RegExp
  args: (archive: string, into: string) => string[]
}[] = [
  ...['7z', '7zz'].map((name) => ({
    name,
    opens: /./,
    // A password that can't be right: without one, 7-Zip would wait for it to be typed.
    args: (archive: string, into: string) => [
      'x',
      '-y',
      '-bso0',
      '-bsp1',
      '-pplexo',
      `-o${into}`,
      archive
    ]
  })),
  {
    name: 'unrar',
    opens: /\.rar$/i,
    args: (archive, into) => ['x', '-o+', '-p-', '-y', archive, `${into}${sep}`]
  },
  { name: 'unar', opens: /./, args: (archive, into) => ['-f', '-D', '-o', into, archive] }
]

/** The first volume of an archive, the one to unpack it from: `x.rar` (older volumes go on as
 * `x.r00`), `x.part01.rar`, `x.7z` or `x.7z.001`, `x.zip`. */
export function isFirstVolume(name: string): boolean {
  if (/\.part\d+\.rar$/i.test(name)) return /\.part0*1\.rar$/i.test(name)
  return /\.(rar|7z|zip|7z\.0*1)$/i.test(name)
}

/** Every volume of the archive `first` begins, among `names`. */
export function volumesOf(first: string, names: readonly string[]): string[] {
  const stem = first.replace(/(\.part\d+)?\.rar$|\.7z(\.\d+)?$|\.zip$/i, '')
  return names.filter(
    (name) =>
      name.startsWith(stem) &&
      /^(\.part\d+\.rar|\.rar|\.r\d{2,3}|\.7z(\.\d{3})?|\.zip|\.z\d{2})$/i.test(
        name.slice(stem.length)
      )
  )
}

const articles = (count: number): string =>
  `${count} ${count === 1 ? 'article wasn’t' : 'articles weren’t'}`

/**
 * After an NZB download's articles are in and its files cut to size: repairs its files with its
 * .par2 files where articles were missing, then unpacks its archives into its folder, and (the
 * user's setting) deletes the archives and .par2 files once that worked.
 *
 * It uses the user's own par2 and 7-Zip (or unrar, or unar), as installed: Plexo bundles none.
 * Without one, the download still completes, saying which to install; with a password-protected
 * archive, saying so. Damage its .par2 files can't repair throws. Every
 * article is already checked (CRC-32) as it comes, so a download missing none isn't verified
 * again.
 *
 * Stopped partway (a quit, a crash), it can run again from `state` as it was saved: a repair
 * done is not done twice, and what an unpack cut short wrote goes before it starts over.
 */
export async function postProcess(job: {
  folder: string
  /** Its NZB's files, as saved in the folder. */
  files: readonly string[]
  /** Its articles that are missing. */
  missing: number
  deleteArchives: boolean
  /** Kept up to date as it goes; `changed` is called each time. */
  state: NzbPostProcess
  changed: () => void
  /** Saves `state` now: a relaunch must know where it got to. */
  checkpoint: () => Promise<void>
  signal: AbortSignal
}): Promise<void> {
  const { folder, missing, state, signal } = job
  const at = (stage: NzbPostProcess['stage'], percent?: number): void => {
    state.stage = stage
    state.percent = percent
    job.changed()
  }
  try {
    const saved = new Set(await readdir(folder))
    const par2Files = job.files.filter((name) => /\.par2$/i.test(name) && saved.has(name))
    if (missing > 0 && !state.repaired && par2Files.length > 0) {
      const par2 = await findTool('par2')
      if (!par2) {
        state.missingTool = 'par2'
        return
      }
      // A set's index file, or its first volume when that's all there is.
      const sets = par2Files.filter((name) => !/\.vol\d+[+-]\d+\.par2$/i.test(name))
      at('verifying')
      await job.checkpoint()
      for (const set of sets.length > 0 ? sets : par2Files.slice(0, 1)) {
        // -p: once repaired, the damaged originals par2 keeps (`name.1`) and the .par2 files go.
        const args = ['r', ...(job.deleteArchives ? ['-p'] : []), join(folder, set)]
        const { code, output } = await runTool(par2, args, folder, signal, (text) =>
          at(
            /Repairing/.test(text) || state.stage === 'repairing' ? 'repairing' : 'verifying',
            percentIn(text) ?? state.percent
          )
        )
        if (code === 2) {
          throw new Error(
            `${articles(missing)} on the news server, more than the download’s .par2 files can repair.`
          )
        }
        if (code !== 0) throw new Error(`par2 couldn’t repair the download: ${lastLine(output)}`)
      }
      state.repaired = true
      await job.checkpoint()
    }
    // With gaps left in them, its archives can't be unpacked.
    if (missing > 0 && !state.repaired) return
    await unpack(job, at)
  } finally {
    // Stopped by a quit or a cancel, the stage stays: it tells a relaunch it isn't done.
    if (!signal.aborted) {
      state.stage = undefined
      state.percent = undefined
    }
    job.changed()
  }
}

/** Removes from `folder` what isn't in `kept`: what an unpack added. */
async function removeAdded(folder: string, kept: ReadonlySet<string>): Promise<void> {
  for (const name of await readdir(folder)) {
    if (!kept.has(name)) await rm(join(folder, name), { recursive: true, force: true })
  }
}

async function unpack(
  job: Parameters<typeof postProcess>[0],
  at: (stage: NzbPostProcess['stage'], percent?: number) => void
): Promise<void> {
  const { folder, state, signal } = job
  // As the folder was before the first try: one cut short left more in it.
  if (state.beforeUnpack) await removeAdded(folder, new Set(state.beforeUnpack))
  const names = await readdir(folder)
  const archives = names.filter(isFirstVolume)
  if (archives.length === 0) return
  const before = new Set(names)
  state.beforeUnpack = names
  at('unpacking')
  await job.checkpoint()
  let unpacked = false
  try {
    for (const archive of archives) {
      const tools: { path: string; args: string[] }[] = []
      for (const unpacker of UNPACKERS) {
        const path = unpacker.opens.test(archive) && (await findTool(unpacker.name))
        if (path) tools.push({ path, args: unpacker.args(join(folder, archive), folder) })
      }
      if (tools.length === 0) {
        state.missingTool = '7z'
        return
      }
      let failure = ''
      for (const tool of tools) {
        at('unpacking')
        const { code, output } = await runTool(tool.path, tool.args, folder, signal, (text) =>
          at('unpacking', percentIn(text) ?? state.percent)
        )
        if (code === 0) {
          failure = ''
          break
        }
        if (/password/i.test(output)) {
          state.note = `${archive} is password-protected, which Plexo can’t unpack yet. Its files are in the folder as posted.`
          return
        }
        failure = lastLine(output)
      }
      if (failure) {
        state.note = `Plexo couldn’t unpack ${archive} (${failure}). Its files are in the folder as posted.`
        return
      }
    }
    unpacked = true
  } finally {
    // Half unpacked, or stopped: what it added goes, the download as posted stays.
    if (!unpacked) await removeAdded(folder, before)
  }
  state.unpacked = true
  state.unpackedFiles = (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    .filter((path) => !before.has(path.split(sep)[0]))
  if (!job.deleteArchives) return
  const volumes = new Set(archives.flatMap((archive) => volumesOf(archive, names)))
  for (const name of names) {
    if (volumes.has(name) || /\.par2$/i.test(name)) await rm(join(folder, name), { force: true })
  }
}
