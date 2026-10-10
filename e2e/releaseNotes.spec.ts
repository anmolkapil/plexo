import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const builds = (version: string): string[] => [
  `plexo-${version}-arm64.AppImage`,
  `plexo-${version}-arm64.dmg`,
  `plexo-${version}-setup.exe`,
  `plexo-${version}-x64.dmg`,
  `plexo-${version}-x86_64.AppImage`,
  `plexo-${version}.aarch64.rpm`,
  `plexo-${version}.x86_64.rpm`,
  `plexo_${version}_amd64.deb`,
  `plexo_${version}_arm64.deb`
]

/** What the app's updater reads besides the downloads (see src/main/updater.ts); the release
 * notes never list them. */
const updateFiles = (version: string): string[] => [
  `plexo-${version}-arm64-mac.zip`,
  `plexo-${version}-x64-mac.zip`,
  `plexo-${version}-arm64-mac.zip.blockmap`,
  `plexo-${version}-setup.exe.blockmap`
]
const channelFiles = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']

/** Writes channel files the way electron-builder does: the version first. */
function writeChannelFiles(root: string, version: string, names = channelFiles): void {
  for (const name of names) {
    writeFileSync(join(root, 'dist', name), `version: ${version}\nfiles: []\n`)
  }
}

/** A changelog with one entry for each of `versions`, in docs/changelog.js's shape. */
function writeChangelog(root: string, versions: string[]): void {
  const entries = versions.map((version) => ({
    version: `v${version}`,
    items: [{ kind: 'fixed', title: 'Fixes', text: `What changed in ${version}.` }]
  }))
  writeFileSync(
    join(root, 'docs/changelog.js'),
    `module.exports.PlexoChangelog = ${JSON.stringify(entries)}\n`
  )
}

function prepareRelease(root: string, files: string[]): string {
  for (const dir of ['scripts', 'docs', 'dist']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['scripts/release-notes.mjs', 'docs/downloads.js']) {
    copyFileSync(resolve(__dirname, '..', file), join(root, file))
  }
  writeChangelog(root, ['1.0.0-rc.1', '1.0.0', '1.0.0-rc.11+build.1'])
  for (const file of files) writeFileSync(join(root, 'dist', file), 'build')
  return join(root, 'scripts/release-notes.mjs')
}

test.describe('release artifact selection @smoke', () => {
  test.afterEach(() => {
    rmSync(test.info().outputPath('release'), { recursive: true, force: true })
  })

  for (const version of ['1.0.0-rc.1', '1.0.0', '1.0.0-rc.11+build.1']) {
    test(`only ${version} builds appear in the upload list and release notes`, () => {
      const root = test.info().outputPath('release')
      const expected = builds(version)
      // 1.0.0-rc.10's files must not pass for 1.0.0-rc.1's, nor 1.0.0-rc.11's for 1.0.0's.
      const otherBuilds = ['1.0.0-rc.10', '1.0.0-rc.11', '1.0.0', '11.0.0']
        .filter((other) => other !== version)
        .flatMap((other) => [...builds(other), ...updateFiles(other)])
      const noise = [`plexo_${version}_amd64.snap`]
      const script = prepareRelease(root, [
        ...expected,
        ...updateFiles(version),
        ...otherBuilds,
        ...noise
      ])
      writeChannelFiles(root, version)
      const files = spawnSync(process.execPath, [script, `v${version}`, '--files'], {
        encoding: 'utf8'
      })
      expect(files.status, files.stderr).toBe(0)
      expect(files.stdout.trim().split('\n').sort()).toEqual(
        [...expected, ...updateFiles(version), ...channelFiles]
          .map((file) => join(root, 'dist', file))
          .sort()
      )

      const notes = spawnSync(process.execPath, [script, `v${version}`], { encoding: 'utf8' })
      expect(notes.status, notes.stderr).toBe(0)
      expect(notes.stdout).toContain(
        `## What's new\n\n- **Fixed: Fixes.** What changed in ${version}.\n\n## Downloads`
      )
      for (const file of expected) {
        const url = `https://github.com/anmolkapil/plexo/releases/download/v${version}/${file}`
        expect(notes.stdout.split(url + ')')).toHaveLength(2)
      }
      for (const file of [...otherBuilds, ...noise, ...updateFiles(version), ...channelFiles]) {
        expect(notes.stdout).not.toContain(file)
      }
    })
  }

  // The workflow runs --changelog before building, so a tag without notes stops there.
  test('a version with no changelog entry is refused', () => {
    const root = test.info().outputPath('release')
    const script = prepareRelease(root, builds('1.0.0-rc.2'))
    writeChannelFiles(root, '1.0.0-rc.2')
    for (const mode of [[], ['--files'], ['--changelog']]) {
      const result = spawnSync(process.execPath, [script, 'v1.0.0-rc.2', ...mode], {
        encoding: 'utf8'
      })
      expect(result).toMatchObject({
        status: 1,
        stdout: '',
        stderr: expect.stringContaining('No v1.0.0-rc.2 entry in docs/changelog.js')
      })
    }
  })

  // Either way the release would reach no installed app, or point them all at another build.
  test('a release without its own latest*.yml is refused', () => {
    const root = test.info().outputPath('release')
    const script = prepareRelease(root, builds('1.0.0'))
    const run = (): { status: number | null; stderr: string } =>
      spawnSync(process.execPath, [script, 'v1.0.0', '--files'], { encoding: 'utf8' })

    expect(run()).toMatchObject({ status: 1, stderr: expect.stringContaining('No latest*.yml') })

    writeChannelFiles(root, '1.0.0')
    writeChannelFiles(root, '1.0.0-rc.15', ['latest-linux.yml'])
    expect(run()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("latest-linux.yml isn't for 1.0.0")
    })
  })

  for (const version of ['1.0.0-rc.1', '1.0.0']) {
    test(`other versions do not satisfy a missing ${version} build`, () => {
      const script = prepareRelease(test.info().outputPath('release'), builds('1.0.0-rc.11'))
      const result = spawnSync(process.execPath, [script, `v${version}`, '--files'], {
        encoding: 'utf8'
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(`No ${version} builds in dist/`)
    })
  }
})
