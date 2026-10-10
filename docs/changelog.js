/*
 * What's new in each version: the top of its GitHub Release's notes (scripts/release-notes.mjs).
 * A version tag with no entry here doesn't build (.github/workflows/release.yml), so add the
 * entry in the same PR as the version bump, newest first.
 *
 * `kind` is one of new, faster, improved or fixed; `text` may wrap `code` in backticks.
 */
;(function (root) {
  'use strict'

  root.PlexoChangelog = [
    {
      version: 'v1.0.0-rc.15',
      items: [
        {
          kind: 'new',
          title: 'Automatic updates',
          text: 'New versions download in the background and install when you restart. The update button in the bottom bar shows how far along it is. Turn automatic updates off there, or in the Plexo menu on a Mac.'
        },
        {
          kind: 'improved',
          title: 'A signed Mac app',
          text: 'The Mac app is now signed with an Apple Developer ID, provided by [Dhananjay Bhosale](https://github.com/DhananjayBhosale). macOS no longer calls it damaged: allow it once with **Open Anyway** in System Settings → Privacy & Security.'
        },
        {
          kind: 'new',
          title: 'Scheduled downloads',
          text: 'Let downloads run only at set times, like overnight, under Networks → Speed & data limits. Outside those times they wait in the queue. Plexo needs to be running for them to start.'
        },
        {
          kind: 'new',
          title: 'Downloads from your browser',
          text: 'The Plexo extension for Chrome, Edge and Firefox hands a download to Plexo with your sign-in, so files behind a login download as they do in the browser.'
        },
        {
          kind: 'new',
          title: 'Right-click a download',
          text: 'Every action for a download, from Pause to Move file to Trash, is in its right-click menu. Text fields get Cut, Copy and Paste too.'
        },
        {
          kind: 'improved',
          title: 'Easier on busy networks',
          text: 'Downloads on Auto now share each network’s 32 streams instead of each taking 32, and up to four run at once.'
        },
        {
          kind: 'fixed',
          title: 'Smaller fixes',
          text: 'Servers that answered Plexo’s first check with the whole file now download in parallel, and file names sent encoded (like `=?UTF-8?B?…?=`) are saved readable.'
        }
      ]
    },
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
