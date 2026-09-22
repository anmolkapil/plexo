/*
 * What Plexo's download page and its GitHub Release notes say about each file we ship, and which
 * one to put in front of a visitor. Plain ES5 so the page can load it as-is; the release-notes
 * script and the tests load it with require().
 *
 * Everything is derived from the release's file names (see electron-builder.yml for how they're
 * made), so a file that isn't recognised — update metadata, blockmaps, a snap — is simply left
 * out, and a new build shows up as soon as its name says what it is.
 */
;(function (root) {
  'use strict'

  var OS_ORDER = ['mac', 'win', 'linux']
  var OS_LABEL = { mac: 'macOS', win: 'Windows', linux: 'Linux' }

  // Shown under each OS's downloads. `code` spans are wrapped in backticks.
  var NOTES = {
    mac: [
      'Plexo isn’t signed with an Apple Developer certificate yet, so macOS asks you to confirm the first launch: open the app once, then go to System Settings → Privacy & Security and choose Open Anyway.',
      'If macOS says the app is damaged or can’t be opened, run `xattr -dr com.apple.quarantine /Applications/Plexo.app` in Terminal and open it again.',
      'Not sure which Mac you have? Apple menu → About This Mac: “Chip: Apple M…” is Apple silicon, “Processor: Intel…” is Intel.'
    ],
    win: [
      'The installer isn’t code-signed yet, so Windows may say “Windows protected your PC”. Choose More info, then Run anyway.',
      'One installer covers both regular (x64) and ARM PCs.'
    ],
    linux: [
      'AppImage: `chmod +x plexo-*.AppImage`, then run it. Recent Ubuntu needs FUSE 2 first: `sudo apt install libfuse2t64` (older releases call it `libfuse2`) — or use the .deb, which needs nothing extra.',
      '.deb: `sudo apt install ./plexo_*.deb`.',
      'Using more than one network needs Linux kernel 5.7 or newer (any current distro); on older kernels Plexo can only use the default network.'
    ]
  }

  /** Says what a release file is, from its name; null for anything we don't offer as a download. */
  function describe(name) {
    var n = String(name).toLowerCase()
    var arch = /(arm64|aarch64)/.test(n) ? 'arm64' : /(x86_64|x64|amd64)/.test(n) ? 'x64' : 'any'

    if (/\.dmg$/.test(n)) {
      if (arch === 'arm64') return mk('mac', arch, 'dmg', 'Apple silicon', 'M1 and later · .dmg', 0)
      if (arch === 'x64') return mk('mac', arch, 'dmg', 'Intel', 'Intel Macs · .dmg', 1)
      return mk('mac', arch, 'dmg', 'macOS', '.dmg', 2)
    }
    if (/\.exe$/.test(n)) {
      // Our installer carries no architecture in its name because one file holds both.
      if (arch === 'any') {
        return mk('win', arch, 'exe', 'Windows 10 and 11', 'Installer · x64 and ARM64', 0)
      }
      if (arch === 'x64') {
        return mk('win', arch, 'exe', 'Windows · x64', 'Installer · Intel and AMD PCs', 1)
      }
      return mk('win', arch, 'exe', 'Windows on ARM', 'Installer · ARM PCs', 2)
    }
    if (/\.appimage$/.test(n)) {
      return mk(
        'linux',
        arch,
        'appimage',
        'AppImage' + archSuffix(arch),
        'Runs on any distro, no install',
        arch === 'arm64' ? 2 : 0
      )
    }
    if (/\.deb$/.test(n)) {
      return mk(
        'linux',
        arch,
        'deb',
        'Debian / Ubuntu' + archSuffix(arch),
        '.deb package · Debian, Ubuntu, Mint',
        arch === 'arm64' ? 3 : 1
      )
    }
    if (/\.rpm$/.test(n)) {
      return mk(
        'linux',
        arch,
        'rpm',
        'Fedora / RHEL' + archSuffix(arch),
        '.rpm package · Fedora, RHEL, openSUSE',
        arch === 'arm64' ? 5 : 4
      )
    }
    return null
  }

  function archSuffix(arch) {
    return arch === 'arm64' ? ' · ARM64' : arch === 'x64' ? ' · x86_64' : ''
  }

  function mk(os, arch, kind, title, detail, sort) {
    return { os: os, arch: arch, kind: kind, title: title, detail: detail, sort: sort }
  }

  /**
   * Which OS and CPU the visitor is on, as far as the browser will say. `nav` is what the page has
   * on `navigator`; `hint` is the result of userAgentData.getHighEntropyValues(['architecture']),
   * which only Chromium browsers provide. `arch` is null when there is no evidence, and the page
   * must not pretend otherwise: Safari and Firefox never say what chip a Mac has.
   */
  function detectEnvironment(nav, hint) {
    var ua = String((nav && nav.userAgent) || '')
    var platform = String((nav && nav.platform) || '')
    var s = ua + ' ' + platform
    var touch = Number((nav && nav.maxTouchPoints) || 0)

    // iPadOS reports itself as a Mac, with a touch screen.
    if (/Android|iPhone|iPad|iPod/i.test(s) || (/Mac/i.test(platform) && touch > 1)) {
      return { os: 'mobile', arch: null }
    }
    if (/CrOS/.test(s)) return { os: 'other', arch: null }

    var os = /Windows|Win32|Win64/i.test(s)
      ? 'win'
      : /Macintosh|MacIntel|Mac OS X/i.test(s)
        ? 'mac'
        : /Linux|X11/i.test(s)
          ? 'linux'
          : 'other'

    var arch = null
    if (hint && hint.architecture) {
      arch = hint.architecture === 'arm' ? 'arm64' : hint.architecture === 'x86' ? 'x64' : null
    } else if (os === 'linux') {
      arch = /aarch64|arm64|armv8/i.test(s) ? 'arm64' : /x86_64|x64|amd64/i.test(s) ? 'x64' : null
    }
    return { os: os, arch: arch }
  }

  function formatSize(bytes) {
    if (!bytes) return ''
    var mb = bytes / 1048576
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(mb >= 100 ? 0 : 1) + ' MB'
  }

  function byArch(assets, arch) {
    for (var i = 0; i < assets.length; i++) if (assets[i].arch === arch) return assets[i]
    return null
  }

  /** The download to put in the big button, plus the ways out if it's the wrong one. */
  function choose(assets, env) {
    var mine = assets.filter(function (a) {
      return a.os === env.os
    })
    if (!mine.length) return null
    var alternates = []
    var hint = null
    var primary

    if (env.os === 'mac') {
      // Only Apple silicon Macs are still sold, and macOS 27 needs one, so that is the default
      // when the browser can't say. Either way the other chip is one click away.
      var want = env.arch || 'arm64'
      primary = byArch(mine, want) || mine[0]
      var other = mine.filter(function (a) {
        return a !== primary
      })[0]
      if (other) {
        alternates.push({
          text:
            primary.arch === 'x64'
              ? 'On an Apple silicon Mac? Get the Apple silicon build'
              : 'On an Intel Mac? Get the Intel build',
          asset: other
        })
      }
      if (!env.arch) hint = 'Not sure which? Apple menu → About This Mac.'
    } else if (env.os === 'win') {
      primary = byArch(mine, env.arch || 'any') || byArch(mine, 'any') || mine[0]
      mine.forEach(function (a) {
        if (a !== primary) alternates.push({ text: 'Get ' + a.title, asset: a })
      })
    } else {
      var arch = env.arch || 'x64'
      var images = mine.filter(function (a) {
        return a.kind === 'appimage'
      })
      primary = byArch(images, arch) || images[0] || mine[0]
      var pkg = mine.filter(function (a) {
        return a.kind === 'deb' && a.arch === primary.arch
      })[0]
      if (pkg) alternates.push({ text: 'On Debian or Ubuntu? Get the .deb', asset: pkg })
      if (!env.arch) {
        var arm = byArch(images, 'arm64')
        if (arm && arm !== primary) {
          alternates.push({ text: 'On an ARM64 machine? Get the ARM64 AppImage', asset: arm })
        }
      }
    }
    return { primary: primary, alternates: alternates, hint: hint }
  }

  /**
   * Everything the page shows for a release: the recommended download, its alternatives, and every
   * file grouped by OS with the notes that go with it. `release` is a GitHub release object.
   */
  function build(release, env) {
    var assets = ((release && release.assets) || [])
      .map(function (a) {
        var d = describe(a.name)
        if (!d) return null
        d.file = a.name
        d.size = a.size || 0
        d.sizeText = formatSize(a.size)
        d.url = a.browser_download_url
        return d
      })
      .filter(Boolean)

    var chosen = choose(assets, env || { os: 'other', arch: null })
    var primary = chosen && chosen.primary

    var groups = OS_ORDER.map(function (os) {
      var rows = assets
        .filter(function (a) {
          return a.os === os
        })
        .sort(function (a, b) {
          return a.sort - b.sort
        })
        .map(function (a) {
          a.recommended = a === primary
          return a
        })
      return { os: os, label: OS_LABEL[os], rows: rows, notes: NOTES[os] }
    }).filter(function (g) {
      return g.rows.length > 0
    })

    var desktop = env && (env.os === 'mac' || env.os === 'win' || env.os === 'linux')
    return {
      groups: groups,
      primary: primary
        ? {
            asset: primary,
            title: 'Download for ' + OS_LABEL[env.os],
            meta: primary.title + (primary.sizeText ? ' · ' + primary.sizeText : '')
          }
        : null,
      alternates: chosen ? chosen.alternates : [],
      hint: chosen ? chosen.hint : null,
      desktop: !!desktop,
      empty: assets.length === 0
    }
  }

  /**
   * The downloads table for a GitHub Release's notes — the same names and descriptions as the
   * page. `files` is [{ name, size, url }].
   */
  function markdown(files, siteUrl) {
    var model = build(
      {
        assets: files.map(function (f) {
          return { name: f.name, size: f.size, browser_download_url: f.url }
        })
      },
      { os: 'other', arch: null }
    )
    var out = ['## Downloads', '']
    model.groups.forEach(function (g) {
      out.push('**' + g.label + '**', '', '| Download | For | Size |', '|---|---|---|')
      g.rows.forEach(function (r) {
        out.push('| [' + r.title + '](' + r.url + ') | ' + r.detail + ' | ' + r.sizeText + ' |')
      })
      out.push('')
    })
    out.push(
      'Not signed yet, so macOS and Windows ask you to confirm the first launch — how, and what ' +
        'Linux needs: ' +
        siteUrl +
        '#downloads'
    )
    return out.join('\n')
  }

  root.PlexoDownloads = {
    describe: describe,
    detectEnvironment: detectEnvironment,
    build: build,
    markdown: markdown,
    formatSize: formatSize
  }
})(typeof window !== 'undefined' ? window : module.exports)
