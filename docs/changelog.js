/*
 * The "What's new" panel on the download page. The page shows the entry whose `version` matches
 * the latest GitHub release's tag; a release with no entry here falls back to its own notes.
 *
 * Add the next version's entry before publishing it, newest first. `kind` is one of new, faster,
 * improved or fixed; `text` may wrap `code` in backticks.
 */
;(function (root) {
  'use strict'

  root.PlexoChangelog = [
    {
      version: 'v1.0.0-rc.10',
      items: [
        {
          kind: 'new',
          title: 'Switch networks mid-download',
          text: 'Networks can join, leave or be ticked on and off while a download runs. Unplug your phone and the download carries on over Wi-Fi; plug it back in and add it again.'
        },
        {
          kind: 'new',
          title: 'Waits instead of failing',
          text: 'With no network available, a download waits for one to come back. An error keeps the partial file, so you can resume from the error screen.'
        },
        {
          kind: 'faster',
          title: 'Picks its own stream count',
          text: 'Each network starts with 4 streams and Plexo adds more only while they actually add speed, so the streams setting is gone.'
        },
        {
          kind: 'faster',
          title: 'Reuses connections',
          text: 'Each stream keeps one connection open instead of reconnecting for every 8 MB block, which saves a handshake per block.'
        },
        {
          kind: 'improved',
          title: 'Writes straight to your folder',
          text: 'Downloads go into a `.plexo` file in the folder you chose and take their real name when they finish, with no copy at the end.'
        },
        {
          kind: 'improved',
          title: 'Rides out busy servers and sleep',
          text: 'Busy servers are waited out, connections recover when your computer wakes up, and the computer stays awake while a download runs. IPv6 now works on every network you select.'
        },
        {
          kind: 'improved',
          title: 'Windows installer options',
          text: 'Choose where Plexo is installed, and whether it adds a desktop shortcut.'
        }
      ]
    },
    {
      version: 'v1.0.0-rc.9',
      items: [
        {
          kind: 'new',
          title: 'Remembers your settings',
          text: 'Parallel streams and your download folder are kept between launches, and the app opens with them already in place.'
        },
        {
          kind: 'new',
          title: 'Same-network warning',
          text: 'Plexo warns you when two selected connections are on the same local network, since Windows only uses one adapter then.'
        },
        {
          kind: 'improved',
          title: 'Explains single-connection downloads',
          text: 'When a server can’t split a download, the app now says why only one connection can be used.'
        },
        {
          kind: 'fixed',
          title: 'Smaller fixes',
          text: 'Downloading to a drive root on Windows (like `D:\\`) works, pause and cancel stay visible on small windows, and a dismissed update prompt stays dismissed.'
        }
      ]
    }
  ]
})(typeof window !== 'undefined' ? window : module.exports)
