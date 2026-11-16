# Contributing to Helicon

Thanks for helping. Helicon is an open-source desktop and web app for Meta's Muse Code CLI, built with Tauri, React and TypeScript. You don't need a Muse Code subscription to work on most of it: demo mode runs the whole interface on sample data.

## Your first PR in five steps

1. **Pick an issue.** [Good first issues](https://github.com/HarjjotSinghh/helicon/contribute) are small and each lists the files to touch. [Help wanted](https://github.com/HarjjotSinghh/helicon/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are bigger.
2. **Claim it.** Comment on the issue and wait to be assigned (usually within a day). One person per issue, so nobody's work gets thrown away. If an assigned issue sees no PR or update for 7 days, it goes back to the pool.
3. **Branch from `prod`.** Fork the repo, then `git switch -c fix-sidebar-focus prod`.
4. **Make the change and run the tests** for the workspaces you touched (below).
5. **Open a PR** that says `Closes #123`. The template asks how you tested it. You'll get a first review within 48 hours.

Something you want to build that has no issue yet? Open one first (or start a [Discussion](https://github.com/HarjjotSinghh/helicon/discussions)) so we can agree on the shape before you write code.

## Set up (about 5 minutes)

You need Node 22 or newer and git. If you use NVM, run `nvm use` from the repository root after installing and configuring NVM to activate the Node.js version specified by `.nvmrc`. Rust and the Tauri prerequisites are only needed for the desktop shell.

```bash
git clone https://github.com/<you>/helicon && cd helicon
nvm use
npm install
npm run build --workspace @helicon/daemon --workspace @helicon/ui --workspace @helicon/server
```

### Work on the UI without Muse (demo mode)

```bash
npm run dev:demo --workspace @helicon/web
# open http://localhost:5173
```

Demo mode swaps the server for an in-memory client with sample projects, threads, an approval waiting, usage and models. Sending a message plays back a scripted turn. Edits to `packages/ui` hot-reload. This is the right setup for almost every UI issue.

### Run against a real Muse

If you have the `muse` CLI and have run `muse login` once:

```bash
# terminal 1: the API, talking to your muse
node packages/server/dist/src/cli.js --port 3127
# terminal 2: the UI with hot reload
npm run dev --workspace @helicon/web
# open http://localhost:5173
```

### The website (helicon.sh)

```bash
cd landing && npm install && npm run dev
# open http://localhost:3000
```

### The desktop app

```bash
npm run dev --workspace helicon-desktop
```

Needs [the Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

## Where things live

| Path | What it is |
|---|---|
| `packages/ui` | The whole interface, shared by desktop and web. State in `src/model`, components in `src/components`. Reusable UI goes here, not in `apps/*` |
| `packages/server` | The local HTTP + SSE API the UI talks to |
| `packages/daemon` | Runs `muse serve` and speaks MSP (JSON-RPC over stdio) through `@muse-code/sdk` |
| `apps/web` | The Vite entry for the browser build, plus demo mode (`src/demo`) |
| `apps/desktop` | The Tauri 2 shell (Rust), installers and updater |
| `landing` | helicon.sh, a Next.js site |
| `docs` | Design system ([DESIGN.md](docs/DESIGN.md)), changelog, assets |

## Tests

Run these for the workspaces you touched. None of them need Muse.

```bash
npm run test --workspace @helicon/ui       # about 250 tests, under 10 s
npm run test --workspace @helicon/server
npm run test --workspace @helicon/daemon
npm run test --workspace @helicon/web      # build @helicon/ui first
cd landing && npm test                     # the website
```

CI runs the same on Windows, macOS and Linux, and checks the desktop crate with `cargo check` and `cargo test`.

For UI changes, check light and dark themes and a narrow window, and add a screenshot or short clip to the PR.

## What gets merged

- One change per PR, linked to an issue, with tests where the change has logic in it.
- Commit subjects are short and plain, and say what changed: `Keep focus in the sidebar after renaming a project`. Add a body only when the "why" isn't obvious.
- Merged PRs are credited by handle in the [changelog](docs/CHANGELOG.md) and the release notes.

## Hacktoberfest

Helicon takes part in Hacktoberfest. A PR counts once it's merged, or once it's labelled `hacktoberfest-accepted`.

PRs that won't count, and will be closed and labelled `spam` or `invalid`:

- Typo, whitespace or formatting changes that no issue asked for
- Changes to README badges, contributor lists or this file, made just to have a PR
- Generated or AI-written changes the author clearly didn't run or read
- A second PR for an issue someone else is already assigned to

Using AI tools is fine. Understanding and testing what you submit is on you.

## Ground rules

1. The README's "Unofficial community project" note is the one place that says Helicon is not affiliated with Meta; don't repeat it in names, releases, docs or the app. App UI stays unbranded.
2. Don't use the `Muse` mark in new binary names, bundle IDs, domains or titles.
3. Never commit credentials (`auth.json`, `.env`, API keys). Use your own `muse login`.
4. Never bypass approvals or billing. Surface approval modes honestly.
5. Security problems go to a [private report](https://github.com/HarjjotSinghh/helicon/security/advisories/new), not an issue. See [SECURITY.md](SECURITY.md).

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).

## Versioning

Semver. Every release gets a git tag and a GitHub Release with binaries. Merged PRs with considerable work bump at least the patch version; routine work never bumps major. The maintainer cuts releases.
