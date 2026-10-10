import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = dirname(fileURLToPath(import.meta.url))
const out = join(root, 'dist')
const scripts = join(out, 'scripts')

await rm(out, { recursive: true, force: true })

// One self-contained script each: Firefox's background script can't load modules.
for (const name of ['background', 'popup', 'options']) {
  await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      outDir: scripts,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(root, 'src', `${name}.ts`),
        formats: ['iife'],
        name: 'plexo',
        fileName: () => `${name}.js`
      }
    }
  })
}

const base = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf-8'))
// One manifest per browser: given both background keys, Chrome reports the one it doesn't use as
// an error.
const manifests = {
  chrome: {
    ...base,
    // The first Chrome where every API this calls returns a promise (contextMenus.removeAll).
    minimum_chrome_version: '123',
    background: { service_worker: 'background.js' }
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: { id: 'extension@getplexo.app', strict_min_version: '121.0' }
    }
  }
}

for (const [browser, manifest] of Object.entries(manifests)) {
  const dir = join(out, browser)
  await mkdir(dir, { recursive: true })
  await cp(scripts, dir, { recursive: true })
  for (const file of ['popup.html', 'options.html', 'ui.css']) {
    await cp(join(root, 'src', file), join(dir, file))
  }
  await cp(join(root, 'icons'), join(dir, 'icons'), { recursive: true })
  await cp(join(root, '../src/renderer/src/assets/fonts'), join(dir, 'fonts'), { recursive: true })
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
await rm(scripts, { recursive: true })
console.log(`Built ${Object.keys(manifests).join(' and ')} into ${out}`)
