# Contributing to Plexo

Thanks for taking a look at Plexo. It's a small project, so the process is intentionally lightweight.

## Setup

```bash
git clone https://github.com/anmolkapil/plexo.git
cd plexo
npm install
npm run dev
```

Requires Windows 10/11 or macOS and Node.js 22.12+. See [requirements](README.md#requirements).

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

```bash
npm version <version> --no-git-tag-version     # e.g. 1.0.0-rc.8
npm run build:mac && npm run build:win && npm run build:linux

node scripts/release-notes.mjs v<version> notes.md > body.md   # your notes + the downloads table
gh release create v<version> --prerelease --title v<version> --notes-file body.md \
  $(node scripts/release-notes.mjs v<version> --files)
```

The script only picks up files the download page knows how to describe, so the update metadata and blockmaps electron-builder leaves in `dist/` are never uploaded.

## Reporting bugs

Open a GitHub issue with:

- Operating system and version
- What you were downloading (URL if it's public, or roughly: file size, server type)
- Which network interfaces were involved
- Console/error output if there was a crash

## Ideas / feature requests

Open an issue to discuss before writing a lot of code — happy to talk through approach first, especially for anything touching the chunking/resume logic.
