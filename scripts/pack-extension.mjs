#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const extensionDir = join(rootDir, 'companion-extension')
const distDir = join(rootDir, 'dist')

const manifestPath = join(extensionDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error(`Error: manifest.json not found in ${extensionDir}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const version = manifest.version || '1.0.0'

if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true })
}

const outputZipName = `plexo-companion-v${version}.zip`
const outputZipPath = join(distDir, outputZipName)
const latestZipPath = join(distDir, 'plexo-companion-latest.zip')

console.log(`Packaging Plexo Companion Extension v${version}...`)

let packed = false
try {
  execSync(
    `tar -a -cf "${outputZipPath}" -C "${extensionDir}" manifest.json background popup options icons README.md`,
    { stdio: 'pipe' }
  )
  packed = true
} catch {
  if (process.platform === 'win32') {
    try {
      execSync(
        `powershell -NoProfile -Command "Compress-Archive -Path '${extensionDir}\\*' -DestinationPath '${outputZipPath}' -Force"`,
        { stdio: 'pipe' }
      )
      packed = true
    } catch (err) {
      console.error('Failed to create archive with PowerShell:', err)
    }
  } else {
    try {
      execSync(`cd "${extensionDir}" && zip -r "${outputZipPath}" . -x "*.git*"`, { stdio: 'pipe' })
      packed = true
    } catch (err) {
      console.error('Failed to create archive with zip:', err)
    }
  }
}

if (!packed || !existsSync(outputZipPath)) {
  console.error('Failed to create packed extension zip archive.')
  process.exit(1)
}

copyFileSync(outputZipPath, latestZipPath)

const stats = statSync(outputZipPath)
const sizeKb = (stats.size / 1024).toFixed(1)

console.log(`✓ Packed extension created successfully!`)
console.log(`  File: dist/${outputZipName} (${sizeKb} KB)`)
console.log(`  File: dist/plexo-companion-latest.zip`)
console.log(`Ready for distribution or uploading to the Chrome Web Store / Microsoft Edge Add-ons.`)
