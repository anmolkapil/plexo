/* The landing page uses the shared release classifier in downloads.js. */
;(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)
  const repo = 'https://github.com/anmolkapil/plexo'
  const labels = { mac: 'macOS', win: 'Windows', linux: 'Linux' }
  const sectionIds = ['features', 'downloads', 'faq', 'support']
  const sectionLinks = Array.from(document.querySelectorAll('.nav-section-link'))
  const pageSections = sectionIds.map((id) => $(id)).filter(Boolean)
  let navFrame = 0

  function updateActiveSection() {
    navFrame = 0
    const marker = window.scrollY + Math.min(window.innerHeight * 0.5, 360)
    let activeId = ''
    pageSections.forEach((section) => {
      if (section.offsetTop <= marker) activeId = section.id
    })
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
      activeId = pageSections.at(-1)?.id || activeId
    }
    sectionLinks.forEach((link) => {
      const active = link.hash === '#' + activeId
      if (active) link.setAttribute('aria-current', 'location')
      else link.removeAttribute('aria-current')
    })
  }

  function queueActiveSectionUpdate() {
    if (!navFrame) navFrame = window.requestAnimationFrame(updateActiveSection)
  }

  window.addEventListener('scroll', queueActiveSectionUpdate, { passive: true })
  window.addEventListener('resize', queueActiveSectionUpdate)
  updateActiveSection()

  const revealTargets = Array.from(
    document.querySelectorAll(
      '#features .section-heading, #features .cells > *, #downloads .section-heading, #downloads .download-box, #faq > div > div:first-child, #faq .faq-item, #support > div:first-child, #support .cells > *, footer .giant'
    )
  )
  document.documentElement.classList.add('motion-ready')
  revealTargets.forEach((target, index) => {
    target.classList.add('reveal-on-scroll')
    target.style.setProperty('--reveal-delay', `${(index % 3) * 70}ms`)
  })
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-visible')
          revealObserver.unobserve(entry.target)
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    )
    revealTargets.forEach((target) => revealObserver.observe(target))
  } else {
    revealTargets.forEach((target) => target.classList.add('is-visible'))
  }

  const demoStage = document.querySelector('.demo-stage')
  const demoFrame = document.querySelector('.demo-frame')
  function fitDemoToViewport() {
    if (!demoStage || !demoFrame) return
    const designWidth = 1040
    const scale = Math.min(1, demoStage.clientWidth / designWidth)
    demoFrame.style.width = designWidth + 'px'
    demoFrame.style.transform = 'scale(' + scale + ')'
    demoStage.style.height = Math.ceil(demoFrame.offsetHeight * scale) + 'px'
  }
  window.addEventListener('resize', fitDemoToViewport)
  if ('ResizeObserver' in window) new ResizeObserver(fitDemoToViewport).observe(demoStage)
  document.fonts?.ready.then(fitDemoToViewport)
  window.requestAnimationFrame(fitDemoToViewport)

  const installGuides = {
    mac: {
      title: 'Opening Plexo for the first time on macOS',
      why: 'Plexo isn’t signed with an Apple Developer ID yet, so macOS blocks it the first time you open it. You only need to allow it once.',
      steps: [
        ['Open the .dmg and drag **Plexo** into your **Applications** folder.'],
        ['Open Plexo. When macOS says it can’t verify the app, click **Done**.'],
        ['Open **System Settings → Privacy & Security**, then click **Open Anyway**.']
      ],
      fix: [
        'Seeing “Plexo is damaged and can’t be opened”? Run this in Terminal, then open Plexo again:',
        'xattr -cr /Applications/Plexo.app'
      ]
    },
    win: {
      title: 'Installing Plexo on Windows',
      why: 'Plexo isn’t code-signed yet, so your browser and Windows SmartScreen may warn you before it installs.',
      steps: [
        ['If your browser flags the file, choose **Keep**.'],
        ['On **Windows protected your PC**, click **More info**.'],
        ['Click **Run anyway** and finish the install.']
      ],
      fix: null
    },
    linux: {
      title: 'Running Plexo on Linux',
      why: 'Linux doesn’t block unsigned apps, but each package type has its own first step.',
      steps: [
        [
          '**AppImage:** make it executable, then run it.',
          'chmod +x Plexo-*.AppImage && ./Plexo-*.AppImage'
        ],
        ['**Debian / Ubuntu:** install the .deb with apt.', 'sudo apt install ./plexo_*.deb'],
        ['**Fedora / RHEL:** install the .rpm with dnf.', 'sudo dnf install ./plexo-*.rpm'],
        ['Using more than one network requires **Linux kernel 5.7 or newer**.']
      ],
      fix: [
        'AppImage won’t start on Ubuntu 24.04 or newer? Install FUSE first:',
        'sudo apt install libfuse2t64'
      ]
    }
  }
  let selectedOS = 'mac'

  function selectOS(os) {
    selectedOS = os
    document.querySelectorAll('[data-os]').forEach((tab) => {
      const selected = tab.dataset.os === os
      tab.setAttribute('aria-selected', String(selected))
      tab.tabIndex = selected ? 0 : -1
      $('panel-' + tab.dataset.os).hidden = !selected
    })
    window.requestAnimationFrame(updateTabIndicator)
  }
  const tabs = Array.from(document.querySelectorAll('[data-os]'))
  const osTabs = document.querySelector('.os-tabs')
  function updateTabIndicator() {
    const activeTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
    if (!osTabs || !activeTab) return
    osTabs.style.setProperty('--tab-left', activeTab.offsetLeft + 'px')
    osTabs.style.setProperty('--tab-width', activeTab.offsetWidth + 'px')
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectOS(tab.dataset.os))
    tab.addEventListener('keydown', (event) => {
      let next
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = tabs.length - 1
      if (next === undefined) return
      event.preventDefault()
      selectOS(tabs[next].dataset.os)
      tabs[next].focus()
    })
  })
  window.addEventListener('resize', updateTabIndicator)
  window.requestAnimationFrame(updateTabIndicator)
  $('primary-btn').addEventListener('click', () => {
    if ($('primary-btn').getAttribute('href') === '#downloads') selectOS(selectedOS)
  })

  function element(tag, className, content) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (content) node.textContent = content
    return node
  }
  function safeReleaseURL(value) {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' &&
        url.hostname === 'github.com' &&
        url.pathname.startsWith('/anmolkapil/plexo/releases/')
        ? url.href
        : null
    } catch {
      return null
    }
  }
  function assetLink(asset, className) {
    const link = element('a', className)
    link.href = asset.url
    link.setAttribute('aria-label', 'Download ' + asset.title + ' ' + asset.kind)
    return link
  }
  function appendRichText(node, value) {
    String(value)
      .split('**')
      .forEach((part, index) => node.append(index % 2 ? element('strong', '', part) : part))
  }
  function architectureName(os, arch) {
    if (arch === 'any') return 'x64 & ARM64'
    if (arch === 'arm64') return os === 'mac' ? 'Apple silicon' : 'ARM64'
    return os === 'mac' ? 'Intel' : 'Intel / AMD'
  }
  function architectureNote(os, arch) {
    if (os === 'mac')
      return arch === 'arm64' ? 'Macs with an M-series chip' : 'Macs with an Intel processor'
    if (arch === 'any') return 'One installer for both architectures'
    return arch === 'arm64' ? 'ARM 64-bit computers' : 'Intel and AMD 64-bit'
  }
  function formatLabel(kind) {
    return (
      {
        dmg: 'Disk image (.dmg)',
        exe: 'Installer (.exe)',
        appimage: 'AppImage',
        deb: 'Debian / Ubuntu (.deb)',
        rpm: 'Fedora / RHEL (.rpm)'
      }[kind] || kind
    )
  }
  function heroBuildMeta(asset, release) {
    return [
      architectureName(asset.os, asset.arch),
      formatLabel(asset.kind),
      asset.sizeText,
      release.tag_name || 'Latest'
    ]
      .filter(Boolean)
      .join(' · ')
  }
  function copyButton(command) {
    const button = element('button', 'copy-command', 'Copy')
    button.type = 'button'
    button.dataset.copy = command
    button.setAttribute('aria-label', 'Copy command')
    return button
  }
  function renderInstallGuideBody(os) {
    const guide = installGuides[os]
    const body = element('div', 'install-guide-body')
    body.append(element('p', 'install-guide-intro', guide.why))
    const steps = element('ol', 'install-steps')
    guide.steps.forEach(([description, command], index) => {
      const item = document.createElement('li')
      item.append(element('span', 'install-step-number', String(index + 1)))
      const copy = element('div', 'install-step-copy')
      const text = document.createElement('p')
      appendRichText(text, description)
      copy.append(text)
      if (command) {
        const commandRow = element('div', 'command-row')
        commandRow.append(element('code', '', command), copyButton(command))
        copy.append(commandRow)
      }
      item.append(copy)
      steps.append(item)
    })
    body.append(steps)
    if (guide.fix) {
      const fix = element('div', 'install-fix')
      fix.append(element('p', '', guide.fix[0]))
      const commandRow = element('div', 'command-row')
      commandRow.append(element('code', '', guide.fix[1]), copyButton(guide.fix[1]))
      fix.append(commandRow)
      body.append(fix)
    }
    return body
  }
  function renderInstallGuide(os) {
    const guide = installGuides[os]
    const details = element('details', 'install-help')
    const summary = document.createElement('summary')
    const icon = element('span', 'install-help-icon')
    icon.setAttribute('aria-hidden', 'true')
    const shield = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    shield.setAttribute('viewBox', '0 0 24 24')
    shield.setAttribute('aria-hidden', 'true')
    shield.innerHTML =
      '<path d="M12 3 4.5 6v5.5c0 4.6 3.1 8.4 7.5 9.5 4.4-1.1 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="M12 8v5.25"/><path d="M12 16.5v.01"/>'
    icon.append(shield)
    const title = element('span', 'install-help-title')
    title.append(
      element('strong', '', 'First time opening Plexo?'),
      element('small', '', guide.title)
    )
    summary.append(icon, title, element('span', 'install-help-toggle', '+'))
    details.append(summary, renderInstallGuideBody(os))
    return details
  }
  function placeholderPanels(message) {
    const choices = {
      mac: ['Apple silicon (ARM64)', 'Intel (x64)'],
      win: ['Intel / AMD (x64) and ARM64'],
      linux: ['Intel / AMD (x86_64)', 'ARM64']
    }
    Object.keys(choices).forEach((os) => {
      const panel = $('panel-' + os)
      panel.replaceChildren()
      const list = element('div', 'download-table architecture-list')
      choices[os].forEach((name) => {
        const card = element('div', 'download-row architecture-card placeholder-download-row')
        const platform = element('div', 'download-platform')
        platform.append(element('h3', '', name), element('p', '', message))
        const link = element('a', 'asset-link download-action', 'View builds')
        link.href = repo + '/releases'
        card.append(platform, element('span'), element('span'), link)
        list.append(card)
      })
      panel.append(list)
    })
  }
  placeholderPanels('Finding available builds…')

  async function environment() {
    let hint = null
    try {
      if (navigator.userAgentData?.getHighEntropyValues) {
        hint = await Promise.race([
          navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500))
        ])
      }
    } catch {
      // Safari and Firefox do not disclose CPU architecture. Let the visitor choose.
    }
    return window.PlexoDownloads.detectEnvironment(navigator, hint)
  }

  function renderGroup(group, env) {
    const panel = $('panel-' + group.os)
    panel.replaceChildren()
    if (env.os === group.os && !env.arch && group.rows.some((asset) => asset.arch !== 'any')) {
      panel.append(
        element(
          'p',
          'architecture-notice',
          'We couldn’t identify your processor, so all compatible builds are shown.'
        )
      )
    }
    const list = element('div', 'download-table architecture-list')
    group.rows.forEach((asset) => {
      const row = element('div', 'download-row architecture-card')
      if (asset.recommended) row.classList.add('recommended')
      const platform = element('div', 'download-platform')
      const title = element('span', 'download-platform-title')
      title.append(element('h3', '', architectureName(group.os, asset.arch)))
      if (asset.recommended) title.append(element('span', 'detected-badge', 'Detected'))
      platform.append(title, element('p', '', architectureNote(group.os, asset.arch)))
      const file = element('span', 'download-file', asset.file)
      file.title = asset.file
      const format = element('span', 'download-format')
      format.append(element('span', '', formatLabel(asset.kind)))
      if (asset.sizeText) format.append(element('small', 'download-size', asset.sizeText))
      const link = assetLink(asset, 'asset-link download-action tile')
      link.append(element('span', 'download-symbol', '↓'), element('span', '', 'Download'))
      row.append(platform, format, file, link)
      list.append(row)
    })
    panel.append(list)
    panel.append(renderInstallGuide(group.os))
  }

  function renderRelease(release, env) {
    const cleaned = {
      ...release,
      assets: (release.assets || []).filter((asset) => safeReleaseURL(asset.browser_download_url))
    }
    const model = window.PlexoDownloads.build(cleaned, env)
    const releaseSummary = element('div', 'release-summary')
    releaseSummary.append(
      element(
        'span',
        'release-kicker',
        release.prerelease ? 'Latest pre-release' : 'Latest release'
      )
    )
    const releaseDetails = element('div', 'release-details')
    releaseDetails.append(element('span', 'release-version', release.tag_name || 'Latest'))
    const notes = element('a', '', 'Release notes')
    notes.href = safeReleaseURL(release.html_url) || repo + '/releases'
    releaseDetails.append(notes)
    const archive = element('span', 'release-archive')
    archive.append('Looking for an older build? ')
    const previousReleases = element('a', '', 'Previous releases')
    previousReleases.href = repo + '/releases'
    archive.append(previousReleases)
    releaseSummary.append(releaseDetails, archive)
    $('release-meta').replaceChildren(releaseSummary)
    $('release-meta').classList.add('is-loaded')
    Object.keys(labels).forEach((os) => {
      const group = model.groups.find((group) => group.os === os)
      if (group) renderGroup(group, env)
      else {
        const panel = $('panel-' + os)
        panel.replaceChildren(
          element(
            'p',
            'download-fallback',
            'No ' + labels[os] + ' builds are attached to this release.'
          )
        )
        const link = element('a', 'asset-link', 'Previous releases')
        link.href = repo + '/releases'
        panel.append(link)
      }
    })
    if (labels[env.os]) selectOS(env.os)
    const group = model.groups.find((group) => group.os === env.os)
    const candidates = group?.rows || []
    const universal = candidates.find((asset) => asset.arch === 'any')
    // Never silently default an unknown chip to ARM64 or x64.
    const primary = universal || (env.arch && candidates.find((asset) => asset.arch === env.arch))
    if (primary) {
      $('primary-title').textContent = 'Download for ' + labels[env.os]
      $('primary-btn').href = primary.url
      $('primary-btn').setAttribute(
        'aria-label',
        'Download for ' + labels[env.os] + ': ' + primary.title
      )
      $('hero-download-info').textContent = heroBuildMeta(primary, release)
    } else if (candidates.length) {
      $('primary-title').textContent = 'Download for ' + labels[env.os]
      $('primary-btn').href = '#downloads'
      $('hero-download-info').textContent = env.arch
        ? 'Your architecture isn’t available in this release. See the available builds below.'
        : 'Choose your architecture below — your browser can’t identify it.'
      const choices = candidates.filter(
        (asset, index, rows) => rows.findIndex((other) => other.arch === asset.arch) === index
      )
      choices.forEach((asset) => {
        const link = assetLink(asset, '')
        link.textContent = asset.title + ' ↓'
        $('hero-alternates').append(link)
      })
    } else {
      $('primary-title').textContent = 'Download Plexo'
      if (env.os === 'mobile') {
        const suggestedOS = /Android/i.test(navigator.userAgent) ? 'linux' : 'mac'
        const suggestedGroup =
          model.groups.find((candidate) => candidate.os === suggestedOS) || model.groups[0]
        const suggested =
          suggestedGroup?.rows.find((asset) => asset.arch === env.arch) ||
          suggestedGroup?.rows.find((asset) => asset.arch === 'any') ||
          suggestedGroup?.rows[0]
        $('hero-download-info').textContent = suggested
          ? heroBuildMeta(suggested, release)
          : (env.arch ? architectureName(suggestedOS, env.arch) + ' · ' : '') +
            (release.tag_name || 'Latest')
      } else {
        $('hero-download-info').textContent = 'Available for macOS, Windows & Linux'
      }
    }
  }

  async function loadDownloads() {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 9000)
    try {
      const [response, env] = await Promise.all([
        fetch('https://api.github.com/repos/anmolkapil/plexo/releases?per_page=10', {
          signal: controller.signal
        }),
        environment()
      ])
      if (!response.ok) throw new Error('Release lookup failed')
      const releases = await response.json()
      const release =
        Array.isArray(releases) &&
        releases.find(
          (release) =>
            !release.draft &&
            release.assets?.some((asset) => window.PlexoDownloads.describe(asset.name))
        )
      if (!release) throw new Error('No release builds found')
      renderRelease(release, env)
    } catch {
      $('release-meta').textContent =
        'Couldn’t load the latest builds. You can still download from GitHub.'
      $('release-meta').classList.add('is-loaded')
      $('hero-download-info').textContent =
        'macOS, Windows & Linux · Choose your build in All downloads'
      placeholderPanels('Choose a build from the release assets.')
    } finally {
      clearTimeout(timeout)
    }
  }
  loadDownloads()

  const menu = $('mobile-menu')
  const menuToggle = $('menu-toggle')
  function closeMenu() {
    menu.hidden = true
    menuToggle.setAttribute('aria-expanded', 'false')
  }
  menuToggle.addEventListener('click', () => {
    menu.hidden = !menu.hidden
    menuToggle.setAttribute('aria-expanded', String(!menu.hidden))
  })
  menu.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      closeMenu()
      menuToggle.focus()
    }
  })

  const dialog = $('install-dialog')
  const downloadToast = $('download-help-toast')
  let lastDownload = null
  function showDownloadHelp(asset, href) {
    const guide = installGuides[asset.os]
    if (!guide) return
    lastDownload = { asset, href }
    downloadToast.hidden = true
    $('install-dialog-title').textContent = 'Thanks for downloading Plexo'
    $('install-dialog-subtitle').textContent =
      'Your download has started. Here’s how to open it on ' + labels[asset.os] + ' the first time.'
    $('download-retry').href = href
    const content = $('install-dialog-content')
    content.replaceChildren(renderInstallGuideBody(asset.os))
    dialog.showModal()
  }
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    if (lastDownload) downloadToast.hidden = false
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect()
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        dialog.close()
    }
  })
  $('download-other-builds').addEventListener('click', () => dialog.close())
  $('download-help-reopen').addEventListener('click', () => {
    if (lastDownload) showDownloadHelp(lastDownload.asset, lastDownload.href)
  })
  $('download-help-dismiss').addEventListener('click', () => {
    downloadToast.hidden = true
  })
  document.addEventListener('click', (event) => {
    const copy = event.target.closest('[data-copy]')
    if (copy) {
      const command = copy.dataset.copy
      navigator.clipboard?.writeText(command).then(
        () => {
          copy.textContent = 'Copied'
          window.setTimeout(() => (copy.textContent = 'Copy'), 1800)
        },
        () => {}
      )
      return
    }
    const link = event.target.closest('a')
    if (
      !link ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0 ||
      !link.href.startsWith(repo + '/releases/download/')
    )
      return
    const asset = window.PlexoDownloads.describe(link.href.split('/').pop())
    if (!asset) return
    showDownloadHelp(asset, link.href)
  })

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let paused = reducedMotion.matches
  let elapsed = 0
  let wifiBytes = 219.7
  let usbBytes = 80.5
  let wifi = 34.8
  let usb = 11.4
  const demoFiles = [
    { name: 'Project.zip', kind: 'ZIP', size: 2355 },
    { name: 'ubuntu-24.04-desktop-amd64.iso', kind: 'ISO', size: 5940 },
    { name: 'Footage_Final_4K.mov', kind: 'MOV', size: 3480 }
  ]
  let demoFileIndex = 0
  let demoDoneAt = 0
  const wifiHistory = Array.from({ length: 31 }, (_, i) =>
    i < 4 ? i * 2.7 : 34.8 + Math.sin(i / 2) * 1.3
  )
  const initialTotalHistory = Array.from({ length: 31 }, (_, i) =>
    i < 5 ? i * 8.3 : 44.8 + Math.sin(i / 3) * 3
  )
  const usbHistory = initialTotalHistory.map((value, index) =>
    Math.max(0, value - wifiHistory[index])
  )
  function updateMotionButton() {
    $('demo-motion').textContent = paused ? 'Play demo' : 'Pause demo'
    $('demo-motion').setAttribute('aria-pressed', String(paused))
    document.querySelector('.download-demo').classList.toggle('demo-paused', paused)
  }
  updateMotionButton()
  $('demo-motion').addEventListener('click', () => {
    paused = !paused
    updateMotionButton()
  })
  reducedMotion.addEventListener('change', (event) => {
    paused = event.matches
    updateMotionButton()
  })
  function graphPoint(value, index, max) {
    return ((index * 600) / 30).toFixed(1) + ' ' + (145 - (value / max) * 130).toFixed(1)
  }
  function linePath(values, max) {
    return values
      .map((value, index) => (index ? 'L' : 'M') + graphPoint(value, index, max))
      .join(' ')
  }
  function areaPath(bottom, top, max) {
    const upper = top.map((value, index) => graphPoint(value, index, max))
    const lower = bottom.map((value, index) => graphPoint(value, index, max)).reverse()
    return 'M' + upper.join(' L') + ' L' + lower.join(' L') + ' Z'
  }
  function renderDemo() {
    const file = demoFiles[demoFileIndex]
    const wifiOn = $('wifi-toggle').checked
    const usbOn = $('usb-toggle').checked
    const w = wifiOn ? wifi : 0
    const u = usbOn ? usb : 0
    const total = w + u
    const downloaded = wifiBytes + usbBytes
    const percent = Math.min(100, (downloaded / file.size) * 100)
    const formatMegabytes = (value) =>
      value >= 1024 ? (value / 1024).toFixed(1) + ' GB' : value.toFixed(1) + ' MB'
    $('total-speed').textContent = total.toFixed(1)
    $('wifi-speed').textContent = $('wifi-diagram-speed').textContent = w.toFixed(1) + ' MB/s'
    $('usb-speed').textContent = $('usb-diagram-speed').textContent = u.toFixed(1) + ' MB/s'
    $('demo-file-kind').textContent = file.kind
    $('demo-file-name').textContent = file.name
    $('downloaded').textContent = formatMegabytes(downloaded) + ' of ' + formatMegabytes(file.size)
    $('download-percent').textContent = Math.floor(percent) + '%'
    $('time-left').textContent = demoDoneAt
      ? 'Complete'
      : total
        ? Math.ceil((file.size - downloaded) / total) + 's left'
        : 'Waiting for a network'
    $('file-progress-fill').style.width = percent + '%'
    document
      .querySelector('.file-progress')
      .setAttribute('aria-valuenow', String(Math.floor(percent)))
    document
      .querySelector('.file-progress')
      .setAttribute('aria-label', file.name + ' download progress')
    $('demo-status').textContent = paused
      ? 'Demo paused'
      : demoDoneAt
        ? 'Complete'
        : total
          ? 'Downloading'
          : 'Waiting for network'
    ;[
      ['wifi', w],
      ['usb', u]
    ].forEach(([name, speed]) => {
      const share = total ? (speed / total) * 100 : 0
      $(name + '-contribution').style.width = share + '%'
      $(name + '-share').textContent = Math.round(share) + '%'
      document.querySelector('.' + name + '-row').classList.toggle('off', !speed)
      document.querySelector('.flow-' + name).classList.toggle('off', !speed)
    })
    const stackedHistory = wifiHistory.map((value, index) => value + usbHistory[index])
    const chartMax = Math.max(1, ...stackedHistory)
    const path = linePath(stackedHistory, chartMax)
    const baseline = new Array(wifiHistory.length).fill(0)
    $('chart-line').setAttribute('d', path)
    $('chart-wifi').setAttribute('d', areaPath(baseline, wifiHistory, chartMax))
    $('chart-usb').setAttribute('d', areaPath(wifiHistory, stackedHistory, chartMax))
    $('chart-wifi').classList.toggle('off', !wifiOn)
    $('chart-usb').classList.toggle('off', !usbOn)
  }
  function tick() {
    if (paused || document.hidden) return
    elapsed++
    wifi = 34.8 + Math.sin(elapsed * 0.75) * 1.4 + Math.sin(elapsed * 0.2) * 0.5
    usb = 11.4 + Math.sin(elapsed * 0.47) * 2.4 + Math.cos(elapsed * 0.2) * 0.7
    const w = $('wifi-toggle').checked ? wifi : 0
    const u = $('usb-toggle').checked ? usb : 0
    const file = demoFiles[demoFileIndex]
    if (demoDoneAt && Date.now() - demoDoneAt > 2500) {
      demoFileIndex = (demoFileIndex + 1) % demoFiles.length
      wifiBytes = 0
      usbBytes = 0
      demoDoneAt = 0
    } else if (!demoDoneAt) {
      wifiBytes += w
      usbBytes += u
      const downloaded = wifiBytes + usbBytes
      if (downloaded >= file.size) {
        const scale = file.size / downloaded
        wifiBytes *= scale
        usbBytes *= scale
        demoDoneAt = Date.now()
      }
    }
    wifiHistory.push(w)
    wifiHistory.shift()
    usbHistory.push(u)
    usbHistory.shift()
    renderDemo()
  }
  ;['wifi', 'usb'].forEach((name) =>
    $(name + '-toggle').addEventListener('change', () => {
      const w = $('wifi-toggle').checked ? wifi : 0
      const u = $('usb-toggle').checked ? usb : 0
      wifiHistory[wifiHistory.length - 1] = w
      usbHistory[usbHistory.length - 1] = u
      renderDemo()
      const total = document.querySelector('.demo-total')
      total.classList.remove('speed-pop')
      window.requestAnimationFrame(() => total.classList.add('speed-pop'))
    })
  )
  $('demo-motion').addEventListener('click', renderDemo)
  renderDemo()
  setInterval(tick, 1000)

  $('share-button').addEventListener('click', async () => {
    const url =
      location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname)
        ? 'https://anmolkapil.github.io/plexo/'
        : location.origin + location.pathname
    try {
      if (navigator.share)
        await navigator.share({
          title: 'Plexo',
          text: 'Combine your networks. Download faster.',
          url
        })
      else {
        await navigator.clipboard.writeText(url)
        $('share-status').textContent = 'Link copied. Ready to share.'
        $('share-label').textContent = 'Link copied'
        window.setTimeout(() => ($('share-label').textContent = 'Share Plexo'), 2400)
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        $('share-status').textContent = 'Copy this link: ' + url
      }
    }
  })
})()
