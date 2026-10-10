# Contributing to Plexo

Thanks for taking a look at Plexo. It's a small project, so the process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo
npm install
npm run dev
```

Requires Node.js 22.12+ and npm 9+, on Windows, macOS, or Linux.

## Packaging

- **macOS**: `npm run build:mac` writes `dist/mac/Plexo.app`. A build made on your own Mac isn't quarantined, so it opens without the first-launch step.
- **Windows**: `npm run build:win`, from PowerShell, writes the installer to `dist/`. For an app you run without installing, use `npm run build:unpack` and open `dist/win-unpacked/plexo.exe`.
- **Linux**: `npm run build:linux` writes the AppImage and `.deb` packages to `dist/`

Local builds are unsigned.

## Before opening a PR

```bash
npm run lint
npm run typecheck
npm run format
npm run test:e2e:smoke
```

CI runs these checks on every pull request, with formatting checked rather than applied — if it flags something, `npm run format` fixes it.

`main` takes changes by pull request only: direct pushes and force-pushes are rejected, and CI has to be green before a PR can merge.

Please describe how you checked your change manually (which URL/file size/interfaces you tried) in the PR description.

## End-to-end tests

`e2e/` drives the real built app through the same `window.plexo` API the renderer uses, against a local test server that can drop, stall, corrupt or hold any response at an exact byte. Every test also runs automatic checks: a `completed` download must match the source byte for byte, and anything else must leave no file, part files or open handles behind. The app's window stays hidden while tests run.

```bash
npm run test:e2e:smoke          # what CI runs on every PR (~1 min)
npm run test:e2e                # everything, including @disk and @chaos
PLEXO_CHAOS_RUNS=50 npx playwright test e2e/chaos.spec.ts   # more random sequences
PLEXO_CHAOS_SEED=<seed> npx playwright test e2e/chaos.spec.ts  # replay a chaos failure
```

Tests build the app first; set `PLEXO_E2E_SKIP_BUILD=1` when `out/` is already fresh. Known bugs are written as `test.fail(...)` — when a fix lands, Playwright reports the test as unexpectedly passing, and the marker comes off. Retries are deliberately off: a download test that passes only on a retry has found a race.

## Making changes

- Keep PRs focused — one fix or feature per PR is easier to review than a bundle of unrelated changes.
- Match the existing code style (enforced by `eslint`/`prettier`, run `npm run format` before committing).
- If you're changing download/networking behavior (`src/main/download/`, `src/main/network/`), explain the reasoning in the PR — a lot of the logic there (resume/retry/stall handling) exists to avoid subtle data-corruption bugs, so tradeoffs matter more than usual.
- UI changes: a screenshot or short screen recording in the PR description is very helpful.

## Releasing

A release ships seven files: `Plexo` for macOS (Apple silicon and Intel `.dmg`), Windows (one installer for x64 and ARM64) and Linux (`AppImage` and `.deb`, x86_64 and ARM64). The download page (`docs/`, served by GitHub Pages) reads them from the latest GitHub Release and labels each one from its file name (`docs/downloads.js`), so keep the naming in `electron-builder.yml` intact.

First bump the version and add its entry at the top of `docs/changelog.js`, in one PR. The entry becomes the release notes, and a tag without one stops before building.

```bash
npm version <version> --no-git-tag-version     # e.g. 1.0.0-rc.16
# add the v<version> entry to docs/changelog.js, open the PR, merge it
git checkout main && git pull
git tag v<version> && git push origin v<version>
```

The tag runs `.github/workflows/release.yml`: it builds every OS and leaves a draft GitHub Release with the changelog entry and the downloads table. Check the draft and publish it. Publishing is what ships it: it becomes the Latest release, and within a few hours every running Plexo downloads it in the background and offers a restart. Leave rc releases unmarked as pre-release: the app only updates to Latest, which a pre-release never is. Mark one pre-release (a beta after 1.0, say) to keep it from everyone's automatic updates. A build to throw away? Delete the draft and the tag.

Besides the downloads, a release carries what the app's updater reads (`src/main/updater.ts`): the `latest*.yml` channel files, the macOS `.zip`s and the blockmaps. `scripts/release-notes.mjs --files` lists them; the download page ignores them.

macOS only installs signed updates. The release workflow signs and notarizes the Mac build when these repository secrets are set: `MAC_CERTIFICATE_P12_BASE64` and `MAC_CERTIFICATE_PASSWORD` (a Developer ID Application certificate), and `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` (an App Store Connect API key). Without them a Mac that finds an update sends you to the website for it.

## Microsoft Store

Windows users can also get Plexo from the Microsoft Store. The Store signs the package with Microsoft's certificate, so it installs with no SmartScreen warning, and it hosts and updates it: a Store install's own updater stays off (`process.windowsStore`).

The Store only takes **stable** versions. It reads a version as `x.y.z.0`, so every rc of 1.0.0 would be `1.0.0.0`, and a device only ever moves to a higher version. On a stable tag, the release workflow builds `plexo-<version>-x64.appx` and `-arm64.appx` into the run's **microsoft-store** artifact, separate from the GitHub release.

**Once:**

1. Register as an individual developer in [Partner Center](https://partner.microsoft.com/dashboard). It's free and needs an ID check.
2. Reserve the name: **Apps and games → New product → MSIX or PWA app → Plexo**.
3. Under **Product management → Product identity**, copy three values into `electron-builder.yml`'s `appx`, exactly as shown, including case: `Package/Identity/Name` as `identityName`, `Package/Identity/Publisher` as `publisher`, and `Package/Properties/PublisherDisplayName` as `publisherDisplayName`. Until they're there, a stable release skips the Store package with a warning.
4. In the first submission, fill in:
   - **Store listing:** description and screenshots (1366×768 or larger, from Windows).
   - **Privacy policy URL:** `https://github.com/anmolkapil/plexo/blob/main/PRIVACY.md`.
   - **Properties:** category **Utilities & tools**.
   - **Age ratings:** the questionnaire.
   - **Submission options:** the reason for `runFullTrust`, which every desktop app built with electron-builder declares. For example: _"Plexo is a desktop download manager. It needs full trust to send each download over the network adapters the user picks, save files to folders the user chooses, receive downloads from its browser extension over 127.0.0.1, and open plexo:// links."_

**Each stable release:** download the run's **microsoft-store** artifact, and in Partner Center start a new submission and upload both `.appx` files under **Packages**. Certification takes from a few hours to a few days, and then Store installs update on their own.

To try a package before submitting, run the workflow by hand (`gh workflow run release.yml --ref <branch>`). It builds one with a placeholder identity. Install it on a Windows PC in Developer Mode: unzip the `.appx`, then `Add-AppxPackage -Register .\AppxManifest.xml`. Then run the [Windows App Certification Kit](https://learn.microsoft.com/windows/uwp/debug-test-perf/windows-app-certification-kit) on it, as the Store will.

## Reporting bugs

Open a GitHub issue with:

- Operating system and version
- What you were downloading (URL if it's public, or roughly: file size, server type)
- Which network interfaces were involved
- Console/error output if there was a crash

## Ideas / feature requests

Open an issue to discuss before writing a lot of code — happy to talk through approach first, especially for anything touching the chunking/resume logic.
