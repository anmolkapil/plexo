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
      version: 'v1.0.0-rc.12',
      items: [
        {
          kind: 'new',
          title: 'Torrents',
          text: 'Open magnet links and `.torrent` files. Peers spread across your networks, and you can choose which files to download before it starts or while it runs.'
        },
        {
          kind: 'new',
          title: 'A download queue',
          text: 'Two downloads run at once by default, or set one to eight. The rest wait and start on their own, and finished downloads stay in the list after a restart.'
        },
        {
          kind: 'new',
          title: 'Speed and data limits',
          text: 'Set a total speed limit, a limit per network, and Slow mode for calls. Give a network a daily, weekly or monthly data allowance and Plexo stops using it once it is spent.'
        },
        {
          kind: 'new',
          title: 'Act on many downloads at once',
          text: 'Select downloads to pause, resume, retry, cancel, remove them from the list, or move their files to the Trash.'
        },
        {
          kind: 'new',
          title: 'Fix expired links',
          text: 'Paste a fresh link to the same file and the download carries on from where it stopped.'
        },
        {
          kind: 'improved',
          title: 'A more compact window',
          text: 'Slimmer title bar and header. Speed, the queue, Slow mode, free space and the update button now sit in the bar along the bottom.'
        }
      ]
    },
    {
      version: 'v1.0.0-rc.11',
      items: [
        {
          kind: 'faster',
          title: 'More streams, sooner',
          text: 'Each network starts with 8 streams and doubles once they are all receiving, up to 32. Far-away servers fill your connection much faster.'
        },
        {
          kind: 'new',
          title: 'Pick your stream count',
          text: 'Leave it on Auto, or choose a fixed 4, 8, 16 or 32 streams per network on the start screen.'
        },
        {
          kind: 'improved',
          title: 'Backs off when a server asks',
          text: 'If a server turns some streams away or leaves them unanswered, that network drops to the ones it accepted, then gets one more back each minute.'
        },
        {
          kind: 'faster',
          title: 'Quicker finish',
          text: 'A slow block near the end is raced by a free stream sooner, and raced again if that backup gets stuck too.'
        },
        {
          kind: 'improved',
          title: 'Unticking the last network pauses',
          text: 'Switching off the last network pauses the download, and switching one back on resumes it.'
        }
      ]
    },
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
