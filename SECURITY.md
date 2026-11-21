# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: open the [Security tab](https://github.com/anmolkapil/plexo/security) and click **Report a vulnerability**. Only the maintainer can see the report.

If you landed on this page from the repo's main view and the Security tab link feels hidden, go directly to `https://github.com/anmolkapil/plexo/security/advisories/new`.

A useful report includes:

- what an attacker can do, and what they need first (a crafted link or file, a malicious website, code already running on the computer)
- the steps or a small test that shows it, and the Plexo version and operating system
- a suggested fix, if you have one

## What to expect

Plexo is maintained by one person, so these are aims rather than promises:

- a reply within a week
- an assessment, and a planned fix or an explanation, within a few weeks
- a new release once it's fixed, which reaches users through automatic updates

The advisory is published once the fix has been released, with credit to you unless you'd rather stay anonymous. Please keep the details private until then.

## Supported versions

Only the latest release gets security fixes. Plexo updates itself, so most people are already on it.

## Scope

In scope:

- the Plexo app for macOS, Windows, and Linux, including its download, torrent, and update code
- the browser extension in `extension/`
- the release workflows and build setup in this repository

Out of scope:

- the getplexo.app landing page, unless the problem affects people downloading Plexo
- problems in a dependency that Plexo doesn't expose (please report those upstream)
- a malicious server sending the wrong content for a link you chose to download, unless Plexo makes it worse (for example, by writing outside the folder you picked)
