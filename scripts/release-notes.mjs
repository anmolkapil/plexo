#!/usr/bin/env node
// Builds a GitHub Release from the files in dist/, so the Releases page describes each file the
// same way the download page does (both use docs/downloads.js).
//
//   node scripts/release-notes.mjs v1.0.0-rc.8 [notes.md]   the release body: your notes, then the
//                                                          downloads table
//   node scripts/release-notes.mjs v1.0.0-rc.8 --files      the files to upload, one per line
//
// Only files the download page knows how to describe are included, so update metadata, blockmaps
// and anything else electron-builder leaves in dist/ never reach a release.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { PlexoDownloads: downloads } = createRequire(import.meta.url)('../docs/downloads.js')

const REPO = 'anmolkapil/plexo'
const SITE = 'https://getplexo.app/'

const [tag, arg] = process.argv.slice(2)
if (!tag || !/^v\d/.test(tag)) {
  console.error('usage: release-notes.mjs <tag, e.g. v1.0.0-rc.8> [notes.md | --files]')
  process.exit(2)
}

const version = tag.slice(1)
// RPM names use a dot before the architecture; other builds use a hyphen or underscore.
const artifactName =
  /^plexo[-_](.+)(?:[-_](?:setup|x64|x86_64|amd64|arm64)\.[^.]+|\.(?:x86_64|aarch64)\.rpm)$/
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const files = readdirSync(dist)
  .filter((name) => name.match(artifactName)?.[1] === version && downloads.describe(name))
  .map((name) => ({
    name,
    path: join(dist, name),
    size: statSync(join(dist, name)).size,
    url: `https://github.com/${REPO}/releases/download/${tag}/${name}`
  }))

if (files.length === 0) {
  console.error(
    `No ${version} builds in dist/ — run the build:mac, build:win and build:linux scripts.`
  )
  process.exit(1)
}

if (arg === '--files') {
  // What the app's updater reads (src/main/updater.ts): each OS's channel file (rc-mac.yml, … for
  // an rc; latest-mac.yml, … for a stable release), the zips macOS installs from, and blockmaps,
  // which let an update download only what changed.
  const channel = version.match(/-([a-z]+)/)?.[1] ?? 'latest'
  const channelFile = new RegExp(`^${channel}(-[a-z0-9-]+)?\\.yml$`)
  const updateFiles = readdirSync(dist).filter(
    (name) =>
      channelFile.test(name) ||
      (name.includes(version) && (name.endsWith('-mac.zip') || name.endsWith('.blockmap')))
  )
  // Channel files carry no version in their name, so one left over from an older build would
  // point every app at that build.
  for (const name of updateFiles.filter((name) => name.endsWith('.yml'))) {
    if (!readFileSync(join(dist, name), 'utf-8').includes(`version: ${version}\n`)) {
      console.error(`dist/${name} isn't for ${version} — rebuild that platform.`)
      process.exit(1)
    }
  }
  console.log(
    [...files.map((file) => file.path), ...updateFiles.map((name) => join(dist, name))].join('\n')
  )
} else {
  const notes = arg ? readFileSync(arg, 'utf-8').trim() + '\n\n' : ''
  console.log(notes + downloads.markdown(files, SITE))
  console.error(`${files.length} files: ${files.map((file) => file.name).join(', ')}`)
}
