import { listPackage } from '@electron/asar'
import { join } from 'node:path'

// Check the actual archive, including entries marked as unpacked. A cross-platform build must
// never ship the host's unused WebRTC native binary (rc.12 shipped a macOS binary on Windows).
export default async function checkTorrentPackage(context) {
  const resources = context.packager.getResourcesDir(context.appOutDir)
  const unused = listPackage(join(resources, 'app.asar')).filter((entry) =>
    /\/node_modules\/(node-datachannel|webrtc-polyfill)(\/|$)/.test(entry)
  )
  if (unused.length) {
    throw new Error(`Unused WebRTC dependencies in packaged app: ${unused.join(', ')}`)
  }
}
