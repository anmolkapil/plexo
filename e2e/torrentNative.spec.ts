import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'

test('torrent engine loads without native WebRTC binaries @smoke', async () => {
  // A fresh process avoids a cached import hiding the failure. Packaged Windows builds don't
  // contain the unused WebRTC binary; refuse native loads here to reproduce that environment.
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict'
      process.dlopen = () => { throw new Error('Unexpected native addon load') }
      const { default: WebTorrent } = await import('webtorrent')
      assert.equal(WebTorrent.WEBRTC_SUPPORT, false)
      const client = new WebTorrent({
        utp: false, dht: false, tracker: { wrtc: false },
        lsd: false, natUpnp: false, natPmp: false
      })
      await new Promise((resolve, reject) => client.destroy(error => error ? reject(error) : resolve()))
      console.log('ok')
    `
  ])
  expect(stdout.trim()).toBe('ok')
})
