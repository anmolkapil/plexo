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
  `plexo_${version}_amd64.deb`,
  `plexo_${version}_arm64.deb`
]

function prepareRelease(root: string, files: string[]): string {
  for (const dir of ['scripts', 'docs', 'dist']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['scripts/release-notes.mjs', 'docs/downloads.js']) {
    copyFileSync(resolve(__dirname, '..', file), join(root, file))
  }
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
      const otherBuilds = ['1.0.0-rc.10', '1.0.0-rc.11', '1.0.0', '11.0.0']
        .filter((other) => other !== version)
        .flatMap(builds)
      const noise = [
        'latest.yml',
        `plexo-${version}-arm64.dmg.blockmap`,
        `plexo-${version}-setup.exe.blockmap`,
        `plexo_${version}_amd64.snap`
      ]
      const script = prepareRelease(root, [...expected, ...otherBuilds, ...noise])
      const files = spawnSync(process.execPath, [script, `v${version}`, '--files'], {
        encoding: 'utf8'
      })
      expect(files.status, files.stderr).toBe(0)
      expect(files.stdout.trim().split('\n').sort()).toEqual(
        expected.map((file) => join(root, 'dist', file)).sort()
      )

      const notesPath = join(root, 'notes.md')
      writeFileSync(notesPath, 'Release changes.\n')
      const notes = spawnSync(process.execPath, [script, `v${version}`, notesPath], {
        encoding: 'utf8'
      })
      expect(notes.status, notes.stderr).toBe(0)
      expect(notes.stdout).toContain('Release changes.\n\n## Downloads')
      for (const file of expected) {
        const url = `https://github.com/anmolkapil/plexo/releases/download/v${version}/${file}`
        expect(notes.stdout.split(url + ')')).toHaveLength(2)
      }
      for (const file of [...otherBuilds, ...noise]) expect(notes.stdout).not.toContain(file)
    })
  }

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
