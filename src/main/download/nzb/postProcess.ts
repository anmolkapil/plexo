import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { NzbPostProcess } from '../../../shared/types'
import { renameWithRetry } from '../../jsonFile'

/** Where the tools are looked for: PATH, then where their installers put them without adding
 * them to it (7-Zip's and WinRAR's on Windows; Homebrew's, which an app opened from the Finder
 * doesn't have on its PATH). Only absolute paths: `.` on PATH would find a `7z.exe` the NZB put
 * in the download's folder. */
function toolDirs(): string[] {
  const path = (process.env['PATH'] ?? '').split(delimiter).filter((dir) => isAbsolute(dir))
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

/** Runs `tool` with `args` as they are, never through a shell: file names come from the NZB.
 * Every path in `args` is absolute, so it runs in its own folder, not the download's (where
 * Windows would look for the DLLs it loads). What it prints goes to `onOutput` as it comes;
 * aborting `signal` kills it. */
function runTool(
  tool: string,
  args: string[],
  signal: AbortSignal,
  onOutput: (text: string) => void
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, {
      cwd: dirname(tool),
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
    // Settled once it has exited, also when aborted: on Windows a tool still dying holds its files
    // open, and whatever cleans up after it would fail on them.
    let failed: Error | undefined
    child.on('error', (error) => (failed ??= error))
    child.on('close', (code) => {
      if (signal.aborted) reject(signal.reason)
      else if (failed) reject(failed)
      else resolve({ code: code ?? -1, output })
    })
  })
}

/** What can unpack what, best first: the official 7-Zip (`7zz`) before the `7z` most systems have.
 * 7-Zip opens RAR too, where its build has the codec; unrar is there for builds without it. */
const UNPACKERS: {
  name: string
  opens: RegExp
  args: (archive: string, into: string) => string[]
}[] = [
  ...['7zz', '7z'].map((name) => ({
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
  }
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
 * .par2 files where articles were missing, then unpacks its archives into its folder, and deletes
 * the archives and .par2 files once that worked.
 *
 * It uses the user's own par2 and 7-Zip (or unrar), as installed: Plexo bundles none. Without
 * one, the download still completes, saying which to install; with a password-protected archive,
 * saying so. Damage its .par2 files can't repair throws. Every
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
        state.note = 'Install par2 (par2cmdline) and Plexo repairs downloads like this itself.'
        return
      }
      // A set's index file, or its first volume when that's all there is.
      const sets = par2Files.filter((name) => !/\.vol\d+[+-]\d+\.par2$/i.test(name))
      at('verifying')
      await job.checkpoint()
      for (const set of sets.length > 0 ? sets : par2Files.slice(0, 1)) {
        // -p: once repaired, the damaged originals par2 keeps (`name.1`) and the .par2 files go.
        // -B: the names to repair come from the .par2 file; they resolve in the folder only.
        const args = ['r', '-p', `-B${folder}`, join(folder, set)]
        const { code, output } = await runTool(par2, args, signal, (text) =>
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
    await unpack(job, par2Files, at)
  } finally {
    // Stopped by a quit or a cancel, the stage stays: it tells a relaunch it isn't done.
    if (!signal.aborted) {
      state.stage = undefined
      state.percent = undefined
    }
    job.changed()
  }
}

const STAGING = '.plexo-unpack-'

/** What isn't a plain file or folder in `dir`, at any depth: a link (or a device, a socket) an
 * archive left there. Null when there is none. */
async function oddEntry(dir: string): Promise<string | null> {
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) {
      return relative(dir, join(entry.parentPath, entry.name))
    }
  }
  return null
}

/** `name`, or `name (2)`, `name (3)`, ...: the first neither in `folder` nor `taken` yet. */
async function freeName(folder: string, name: string, taken: Set<string>): Promise<string> {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    const exists = await lstat(join(folder, candidate)).then(
      () => true,
      () => false
    )
    if (!exists && !taken.has(candidate)) return candidate
  }
}

/** Removes the staging folders an unpack cut short left in `folder`, and `added`: what it had
 * moved out of them. Also for a download cancelled after a crash cut its unpack short. */
export async function removeUnpacked(
  folder: string,
  added: readonly string[],
  posted: readonly string[]
): Promise<void> {
  const staging = (await readdir(folder)).filter(
    (name) => name.startsWith(STAGING) && !posted.includes(name)
  )
  for (const name of [...staging, ...added]) {
    // Retries: on Windows an indexer or a virus scanner may hold a file for a moment.
    await rm(join(folder, name), { recursive: true, force: true, maxRetries: 5 })
  }
}

/** Unpacks the archives in the download's folder, each into a new, empty folder of its own and
 * from there into the download's: an archive can't write through a link another one left there.
 * One that holds anything but plain files and folders isn't unpacked. A link and a file through
 * it in one archive are the tool's to refuse, as current 7-Zip and unrar (6.12 on) do. */
async function unpack(
  job: Parameters<typeof postProcess>[0],
  par2Files: readonly string[],
  at: (stage: NzbPostProcess['stage'], percent?: number) => void
): Promise<void> {
  const { folder, state, signal } = job
  // Stopped while its archives were deleted: only that is left to do.
  if (state.unpacked) return removeArchives(job, par2Files)
  // An unpack cut short (a quit, a crash): what it got to goes, and it starts over.
  await removeUnpacked(folder, state.unpackedNames ?? [], job.files)
  state.unpackedNames = []
  // Only its NZB's own files: anything else in the folder isn't the download's to unpack.
  const saved = new Set(await readdir(folder))
  const names = job.files.filter((name) => saved.has(name))
  const archives = names.filter(isFirstVolume)
  if (archives.length === 0) return
  const volumes = new Set(archives.flatMap((archive) => volumesOf(archive, names)))
  // shortcut: the archives' own size, what a release (RAR, stored) unpacks to; a compressed one
  // unpacks to more. Ask each tool for the unpacked size if that turns out to matter.
  let size = 0
  for (const name of volumes) size += (await stat(join(folder, name))).size
  const { bavail, bsize } = await statfs(folder)
  if (bavail * bsize < size) {
    state.note = `There isn’t enough disk space to unpack the download (${formatGigabytes(size)} needed, ${formatGigabytes(bavail * bsize)} free).`
    return
  }
  at('unpacking')
  await job.checkpoint()
  let unpacked = false
  try {
    for (const archive of archives) {
      const tools: { path: string; args: (into: string) => string[] }[] = []
      for (const unpacker of UNPACKERS) {
        const path = unpacker.opens.test(archive) && (await findTool(unpacker.name))
        if (path) tools.push({ path, args: (into) => unpacker.args(join(folder, archive), into) })
      }
      if (tools.length === 0) {
        state.note = 'Install 7-Zip and Plexo unpacks downloads like this itself.'
        return
      }
      let failure = ''
      let into = ''
      for (const tool of tools) {
        // Each try from an empty folder: never over what a tool before it left.
        if (into) await rm(into, { recursive: true, force: true })
        into = await mkdtemp(join(folder, STAGING))
        at('unpacking')
        const { code, output } = await runTool(tool.path, tool.args(into), signal, (text) =>
          at('unpacking', percentIn(text) ?? state.percent)
        )
        if (code === 0) {
          const odd = await oddEntry(into)
          failure = odd ? `it holds ${odd}, which isn’t a file or a folder` : ''
          // Another tool would only make the same link, or one it treats less carefully.
          break
        }
        if (/password/i.test(output)) {
          state.note = `${archive} is password-protected, which Plexo can’t unpack yet.`
          return
        }
        failure = lastLine(output)
      }
      if (failure) {
        state.note = `Plexo couldn’t unpack ${archive} (${failure}).`
        return
      }
      // Into the download's folder, overwriting nothing: names taken get " (2)". Saved first, so
      // a relaunch knows what to remove.
      const moves = new Map<string, string>()
      for (const name of await readdir(into)) {
        const target = await freeName(folder, name, new Set(moves.values()))
        moves.set(name, target)
        state.unpackedNames.push(target)
      }
      await job.checkpoint()
      for (const [name, target] of moves) {
        await renameWithRetry(join(into, name), join(folder, target))
      }
      await rm(into, { recursive: true, force: true })
    }
    unpacked = true
  } finally {
    // Half unpacked, or stopped: what it added goes, the download as posted stays.
    if (!unpacked) {
      await removeUnpacked(folder, state.unpackedNames, job.files)
      state.unpackedNames = []
    }
  }
  state.unpacked = true
  state.unpackedFiles = []
  for (const name of state.unpackedNames) {
    const path = join(folder, name)
    if ((await lstat(path)).isFile()) {
      state.unpackedFiles.push(name)
      continue
    }
    state.unpackedFiles.push(
      ...(await readdir(path, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => relative(folder, join(entry.parentPath, entry.name)))
    )
  }
  // Saved before anything goes: a relaunch mustn't unpack again, with the archives half gone.
  await job.checkpoint()
  await removeArchives(job, par2Files)
}

/** Once unpacked: the download's own archives and .par2 files go, what else is in its folder
 * stays, what unpacking added too (it may hold archives of its own). */
async function removeArchives(
  job: Parameters<typeof postProcess>[0],
  par2Files: readonly string[]
): Promise<void> {
  // Not a name unpacking took, should the NZB list one that never got saved.
  const added = new Set(job.state.unpackedNames)
  const names = job.files.filter((name) => !added.has(name))
  const volumes = names.filter(isFirstVolume).flatMap((archive) => volumesOf(archive, names))
  for (const name of [...volumes, ...par2Files]) {
    // One that can't go (held open on Windows, say) stays: the download is done all the same.
    await rm(join(job.folder, name), { force: true }).catch(() => {})
  }
}

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
