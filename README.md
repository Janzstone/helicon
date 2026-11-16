# Helicon

**A free, MIT-licensed desktop app (Windows, macOS, Linux) and VS Code extension for Meta's Muse Code CLI. Unofficial, not affiliated with Meta.**

**Download:** [Windows](https://helicon.sh/download/windows?src=readme) · [macOS](https://helicon.sh/download/macos?src=readme) · [Linux (AppImage)](https://github.com/HarjjotSinghh/helicon/releases/latest) · [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=harjjotsinghh.helicon) · [Open VSX](https://open-vsx.org/extension/harjjotsinghh/helicon) (Cursor, Windsurf, Antigravity)

**Try it in your browser:** https://helicon.sh/try?utm_source=github&utm_medium=readme&utm_campaign=readme

You need the `muse` CLI installed and signed in (`muse login`) on a Muse Code plan or pay-as-you-go billing. Install guides: [Windows](https://helicon.sh/install/windows) · [macOS](https://helicon.sh/install/macos) · [Linux](https://helicon.sh/install/linux).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/readme-hero-light.png" />
  <img alt="Helicon: open-source desktop & web client for Muse Code" src="docs/assets/readme-hero-light.png" />
</picture>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/installer-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](https://github.com/HarjjotSinghh/helicon/releases/latest)
[![Tauri](https://img.shields.io/badge/desktop-Tauri%202-FFC131.svg)](https://tauri.app)
[![Web](https://img.shields.io/badge/web-shared%20React%20UI-61DAFB.svg)](#architecture)
[![Muse Code](https://img.shields.io/badge/powered_by-Muse%20Code%20CLI%20(MSP)-0668E1.svg)](https://developer.meta.com/ai/products/muse-code)
[![Contributors](https://img.shields.io/github/contributors/HarjjotSinghh/helicon.svg)](https://github.com/HarjjotSinghh/helicon/graphs/contributors)
[![Downloads](https://img.shields.io/github/downloads/HarjjotSinghh/helicon/total.svg?label=installer%20downloads)](https://github.com/HarjjotSinghh/helicon/releases)
[![Latest release](https://img.shields.io/github/v/release/HarjjotSinghh/helicon.svg?label=latest)](https://github.com/HarjjotSinghh/helicon/releases/latest)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/harjjotsinghh.helicon.svg?label=VS%20Code)](https://marketplace.visualstudio.com/items?itemName=harjjotsinghh.helicon)
[![Open VSX](https://img.shields.io/open-vsx/v/harjjotsinghh/helicon.svg?label=Open%20VSX)](https://open-vsx.org/extension/harjjotsinghh/helicon)
[![Stars](https://img.shields.io/github/stars/HarjjotSinghh/helicon.svg?style=social)](https://github.com/HarjjotSinghh/helicon/stargazers)
[![Hacktoberfest](https://img.shields.io/badge/Hacktoberfest-2026-ff8ae2.svg)](https://github.com/HarjjotSinghh/helicon/issues?q=is%3Aissue+is%3Aopen+label%3Ahacktoberfest)
[![Good first issues](https://img.shields.io/github/issues/HarjjotSinghh/helicon/good%20first%20issue.svg?label=good%20first%20issues&color=7057ff)](https://github.com/HarjjotSinghh/helicon/contribute)

<a href="https://www.producthunt.com/products/helicon?utm_source=badge-featured&utm_medium=badge"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1275161&theme=light" alt="Helicon - Featured on Product Hunt" width="250" height="54"></a>

> **Helicon** - home of the Muses. An open-source desktop + web ADE for Meta's **Muse Code CLI** (`muse`), in the spirit of the Claude Code desktop app and the Codex / ChatGPT desktop app.

### Helicon in 30 seconds

[![Helicon in 30 seconds: approvals you can read, diffs where the edit happened, and what each thread would have cost](docs/assets/launch.gif)](docs/assets/helicon-launch.mp4)

Click through for the full-quality video with sound. The cost figures in it are sample data.

### Shared on X

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/social-proof-dark.png" />
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/social-proof-light.png" />
  <img alt="Posts about Helicon from Alexandr Wang, Cosmo Du and Michael Douglas" src="docs/assets/social-proof-light.png" />
</picture>

The posts: [Alexandr Wang](https://x.com/alexandr_wang/status/2100590733627715684) · [Cosmo Du](https://x.com/Answeror/status/2100457921113170092) · [Michael Douglas](https://x.com/mjdouglas/status/2100399865562059121). Helicon is an unofficial community project: Meta has not endorsed it, and it is not affiliated with Meta.

**Sidebar-first:** all projects grouped by working directory, each with its tasks and sessions - resume anything, including sessions started from the `muse` terminal TUI.

[![Helicon walkthrough: open a CLI thread, send a fix, then usage](docs/assets/demo.gif)](https://helicon.sh/?utm_source=github&utm_medium=readme&utm_campaign=readme)

<details>
<summary>Usage and settings</summary>

![Usage: what these threads would have cost at API rates, by day, by model and by thread](docs/assets/usage.png)

![Settings: theme and code colours, what a new thread starts on, approvals, updates](docs/assets/settings.png)

</details>

> ⚠️ **Unofficial community project.** Not made, endorsed, or supported by Meta. Helicon is a client for the **Muse Code CLI**, and is unrelated to the Muse assistant app for Mac. "Muse" and "Muse Code" are trademarks of Meta, used here only to describe what this client connects to. This is **not legal advice** - see [Legal](#legal).

---

## Idea

Muse Code today is terminal-only (`muse`, on macOS, Linux and Windows). Helicon wraps it in a Codex/Claude-style experience:

- **Projects** grouped by directory the agent worked in (incl. isolated worktrees)
- **Sessions/tasks** per project with full history, resume, and diffs
- **Approvals** surfaced honestly (`onRequest / promptUnmatched / denyUnmatched`), never bypassed
- **One codebase** for desktop (Tauri) and web (same React UI against a remote daemon)
- **Windows that actually works** - runs Muse Code for Windows natively (no WSL), or Muse inside WSL2 with path translation if that is what you use
- **A file viewer beside the thread** - browse the project, read highlighted source, preview and edit Markdown, and view images, video and PDFs; paths Muse Code mentions open there
- **Your real plan meter** - the 5-hour window and weekly cap as Muse Code reports them, in the sidebar and on the usage page
- **Goals you can steer** - set, pause, resume, change and clear a `/goal` from the goal panel or the composer
- **Background work under control** - send a running tool call to the background, stop one, or stop them all; cancel a workflow run, or skip and retry its agents
- **Reasoning effort that sticks** - applied as the session's own default, which is the level `muse serve` actually uses

![Starting a thread: recent work per project above the composer](docs/assets/home.png)

![The command palette: threads, projects, and actions on Cmd/Ctrl+K](docs/assets/palette.png)

## Architecture

```
packages/ui      shared React UI (desktop + web, single source of truth)
packages/daemon  Node service: spawns `muse serve` per workspace, speaks MSP (JSON-RPC/stdio)
apps/desktop     Tauri 2 shell (Win/Mac/Linux) wrapping packages/ui
apps/web         same UI against a remote daemon
```

- Protocol: **Muse Session Protocol (MSP)** via the official [`@muse-code/sdk`](https://github.com/meta-models/muse-code-sdk) (MIT) + `muse schema generate-ts` types. No TUI scraping.
- Auth: user's own `muse login` (`~/.config/muse/auth.json`). Helicon never stores credentials.
- State: local SQLite - `projects (cwd/worktree) → sessions → turns`.

## Roadmap

- [x] Name locked: **Helicon** · stack locked: **Tauri + shared React UI**
- [x] PRD + UX spec (sidebar, session view, diffs, approvals) - [docs/PRD.md](docs/PRD.md), [docs/PRODUCT.md](docs/PRODUCT.md)
- [x] `packages/daemon` - MSP connect, list/resume sessions, send/steer, approvals
- [x] `packages/ui` - projects sidebar, session chat, inline diffs, slash commands and skills, goals
- [x] `apps/desktop` - Tauri shell + WSL2 routing + path translation, signed auto-update
- [x] `apps/web` - the same UI in a browser against the local server
- [x] `apps/web` - remote daemon mode
- [x] Windows end to end (native Muse Code for Windows, or WSL2 Ubuntu)
- [x] GitHub Releases with a Windows installer (updater signed; not Authenticode signed yet)
- [x] macOS end to end, and macOS releases (one universal binary for Apple Silicon and Intel)
- [x] Linux builds and releases
- [ ] Post-v1: mobile relay to steer running sessions from a phone

## Install

Windows: download the setup file from the [latest release](https://github.com/HarjjotSinghh/helicon/releases/latest). It is not code signed yet, so SmartScreen may show "Windows protected your PC": click More info, then Run anyway. It updates itself from then on.

Helicon bundles its own Node.js, so you only need Muse Code for Windows (`irm https://dev.meta.ai/install.ps1 | iex` in PowerShell) with `muse login` done once. Already run Muse inside WSL2? Helicon uses that when native Muse is not installed; set `HELICON_MUSE_RUNTIME=wsl` to keep WSL when both are, and `HELICON_WSL_DISTRO=<name>` (for example `Ubuntu-24.04`) to pick the distro instead of WSL's default. Helicon uses the login you already have and never stores credentials of its own.

macOS: download the DMG from the [latest release](https://github.com/HarjjotSinghh/helicon/releases/latest); it runs on Apple Silicon and Intel, and updates itself from then on. The builds are not Apple-notarized yet. On macOS 15 or later, open Helicon once, click Done on the warning, then go to System Settings > Privacy & Security and click Open Anyway. On macOS 14 or earlier, right-click the app, then Open. Or, in Terminal: `xattr -dr com.apple.quarantine /Applications/Helicon.app`.

Helicon bundles its own Node.js, so you only need the `muse` CLI (`curl -fsSL https://dev.meta.ai/install.sh | bash`) with `muse login` done once, however you installed it. Helicon uses the login you already have and never stores credentials of its own.

Linux: download the AppImage (x86_64) from the [latest release](https://github.com/HarjjotSinghh/helicon/releases/latest). It runs on most distributions (it needs FUSE, `libfuse2`, on some of them) and updates itself from then on. Before the first launch, make it executable and run it (`chmod +x Helicon_*.AppImage`, then `./Helicon_*.AppImage`), or right-click it in your file manager and allow executing it as a program.

Helicon bundles its own Node.js, so you only need the `muse` CLI (`curl -fsSL https://dev.meta.ai/install.sh | bash`) with `muse login` done once, however you installed it. Helicon uses the login you already have and never stores credentials of its own.

**VS Code, Cursor, Windsurf, Antigravity:** install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=harjjotsinghh.helicon) or, in Cursor and the other VS Code-based editors, from [Open VSX](https://open-vsx.org/extension/harjjotsinghh/helicon) (or search "Helicon" in the Extensions view). It opens a side panel for the folder you have open: your threads as tabs, History for the earlier ones, readable approvals, and the files each thread changed. Same `muse` login, nothing else to install. Source in [`apps/vscode`](apps/vscode); more at [helicon.sh/install/vscode](https://helicon.sh/install/vscode).

Helicon updates itself, so there is nothing to subscribe to for that. If you would rather read what changed before it lands, use **Watch → Custom → Releases** at the top of this page: GitHub then tells you about each release and nothing else. [Discussions](https://github.com/HarjjotSinghh/helicon/discussions) is the place for questions and for what you are building with it.

## Docs

Longer versions of everything above live on [helicon.sh](https://helicon.sh/?utm_source=github&utm_medium=readme&utm_campaign=readme). Every page has a
Markdown twin at the same path with `.md` appended, for anyone reading this with an agent.

| | |
| --- | --- |
| [Muse Code GUI options](https://helicon.sh/muse-code-gui) | Every graphical interface for Muse Code, including the editor extensions and the other wrappers |
| [The desktop app](https://helicon.sh/muse-code-desktop-app) | What Helicon is, on which platforms, and what it needs from you |
| [Install](https://helicon.sh/install) | [Windows](https://helicon.sh/install/windows) · [macOS](https://helicon.sh/install/macos) · [Linux](https://helicon.sh/install/linux) · [WSL2](https://helicon.sh/install/wsl2) |
| [Comparisons](https://helicon.sh/compare) | Against [the terminal](https://helicon.sh/compare/muse-code-terminal), [VS Code extensions](https://helicon.sh/compare/vs-code-extension), [Zed and JetBrains over ACP](https://helicon.sh/compare/zed-acp), and [the other Muse GUIs](https://helicon.sh/compare/other-muse-code-guis) |
| [Features](https://helicon.sh/features) | One page per capability: [sessions](https://helicon.sh/features/session-history), [diffs](https://helicon.sh/features/inline-diffs), [approvals](https://helicon.sh/features/approvals), [cost](https://helicon.sh/features/cost-and-usage), [remote daemon](https://helicon.sh/features/remote-daemon) |
| [Guides](https://helicon.sh/guides) | [Windows without WSL](https://helicon.sh/guides/muse-code-windows-without-wsl), [resuming a session](https://helicon.sh/guides/resume-a-muse-session), [parallel agents](https://helicon.sh/guides/run-parallel-agents), [when the CLI is not found](https://helicon.sh/guides/muse-cli-not-found) |
| [Glossary](https://helicon.sh/glossary) | [Muse Code](https://helicon.sh/glossary/muse-code), [MSP](https://helicon.sh/glossary/msp), [`muse serve`](https://helicon.sh/glossary/muse-serve), [ACP](https://helicon.sh/glossary/acp), [approvals](https://helicon.sh/glossary/agent-approvals) |
| [FAQ](https://helicon.sh/faq) · [Pricing](https://helicon.sh/pricing) · [Changelog](https://helicon.sh/changelog) | Every question in one page; free and MIT; every release |

For agents: [llms.txt](https://helicon.sh/llms.txt), [llms-full.txt](https://helicon.sh/llms-full.txt),
[AGENTS.md](https://helicon.sh/agents.md), [facts.json](https://helicon.sh/facts.json).

## From source

Prereqs (source builds and the web app only - the desktop installers bundle Node.js): Node 22+, the `muse` CLI with `muse login` done once (natively or in WSL2 on Windows), and the repo checked out.

```bash
npm install
npm run build --workspace @helicon/daemon --workspace @helicon/ui --workspace @helicon/server
npm run build --workspace @helicon/web

# Web app (serves the built UI plus the API on :3127)
npm run serve --workspace @helicon/web
# open http://127.0.0.1:3127, add a folder, start a thread
```

Projects, pins, thread titles and archive state persist in `~/.helicon/helicon.db` (pass `--data-dir` to the server to move it, or `:memory:` for a throwaway run). Threads you started from the `muse` terminal are discovered automatically and appear under their project.

UI development with hot reload:

```bash
# terminal 1: the API against your real muse
node packages/server/dist/src/cli.js --port 3127
# terminal 2: Vite compiles packages/ui straight from source
npm run dev --workspace @helicon/web
# open http://127.0.0.1:5173
```

No `muse` on this machine? `npm run dev:demo --workspace @helicon/web` runs the same UI against an in-memory client with sample projects and threads, no server needed.

The interface itself lives in `packages/ui` (state model in `src/model`, components in `src/components`); design tokens and the visual system are documented in [docs/DESIGN.md](docs/DESIGN.md).

```bash
# Desktop app (dev shell; needs the Tauri prereqs on your OS)
npm run dev --workspace helicon-desktop
```

Releases ride on tags: push `v0.1.0` and the Release workflow builds the Windows installer, then the universal macOS build, then the Linux bundles, and attaches all of them to a GitHub Release. Every release gets a tag; notable merged PRs bump at least the patch version.

The desktop app updates itself from the newest release's `latest.json`, so releases must not be marked prerelease. The installers are signed with the updater key: the workflow reads `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from repo secrets, and a local `tauri build` needs the same two variables set (or pass `--config '{"bundle":{"createUpdaterArtifacts":false}}'` to skip signing for a local-only build).

## Remote daemon

The web app can run against a daemon on another machine. Start it there with a token and the origin that will be loading the page:

```bash
node packages/server/dist/src/cli.js --host 0.0.0.0 --port 3127 \
  --token "$(openssl rand -hex 24)" --allow-origin https://helicon.example
```

Then load the page, go to `#/connect`, and give it the address and the token. Both are kept in local storage rather than in the URL: the token is exchanged once for an `HttpOnly` cookie, which is what the event stream authenticates with, since `EventSource` cannot carry a header.

Two things fail closed deliberately:

- An origin that was never passed to `--allow-origin` gets no CORS headers and no answer at all.
- A token in the query string counts only for requests carrying no other site's origin, so a copied link hands over nothing.

Browsers only accept cross-site cookies over HTTPS, so a daemon reached from another origin needs TLS or a tunnel in front of it. On the same machine none of this applies: `#/connect` with an empty address uses the server that served the page, and no token is needed unless one was set.

## What leaves your machine

Your code, prompts, threads and files stay where they are: Helicon talks to the `muse` CLI on your own computer, with
your own login, and keeps its state in SQLite beside it. There is no account and no analytics in the app.

The one request that does go out is the update check. The desktop app asks `helicon.sh` whether a newer version exists,
which is how it updates itself, and that request tells us an install is alive: the platform, the version it is on, and a
hash of the IP it came from, salted per week so two weeks of logs cannot be joined together. It is how we count roughly
how many installs are in use, since downloads and stars say nothing about that. If the site is unreachable the app falls
back to asking GitHub, as it always did.

## Legal

- Wrapper clients are the intended path (Meta ships an MIT SDK for building MSP clients). This repo builds on that, and on the open-source CLI client.
- **Name:** `Helicon` was chosen to avoid the `Muse` mark. Do not reintroduce `Muse` into the binary name, bundle ID, domain, or title without a trademark review.
- **Never** claim to be official, never bundle credentials, never bypass billing/approvals.
- Contributor-tier reminder: prompts/completions sent on Contributor models may be used to improve Meta's products - surface this in-app before users run it.
- Get a licensed attorney to review before first release. See also: [Meta Brand Resources](https://www.meta.com/brand/resources/meta/our-trademarks), [Muse Code product page](https://developer.meta.com/ai/products/muse-code), [Model API docs](https://dev.meta.ai/docs/coding-agents).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome. See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

**Hacktoberfest:** Helicon takes part. Pick an issue labelled [`good first issue`](https://github.com/HarjjotSinghh/helicon/contribute) or [`help wanted`](https://github.com/HarjjotSinghh/helicon/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22), comment to claim it, and open a PR. Most of them don't need a Muse Code subscription. Every open PR gets a first review within 48 hours, and everyone who lands a change is credited in the [changelog](docs/CHANGELOG.md).

Not a code change? [Discussions](https://github.com/HarjjotSinghh/helicon/discussions) takes questions, setups that did not work, and anything you want Helicon to do that it does not.

### Contributors

Everyone who has landed a change here. Thank you.

<a href="https://github.com/HarjjotSinghh/helicon/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=HarjjotSinghh/helicon" alt="Contributors to Helicon" />
</a>

## Project stats

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=HarjjotSinghh/helicon&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=HarjjotSinghh/helicon&type=Date" />
  <img src="https://api.star-history.com/svg?repos=HarjjotSinghh/helicon&type=Date" alt="Star history for Helicon" width="640" />
</picture>

| | |
| --- | --- |
| Commit activity | [![Commits](https://img.shields.io/github/commit-activity/m/HarjjotSinghh/helicon.svg?label=commits%2Fmonth)](https://github.com/HarjjotSinghh/helicon/graphs/commit-activity) |
| Last commit | [![Last commit](https://img.shields.io/github/last-commit/HarjjotSinghh/helicon.svg?label=)](https://github.com/HarjjotSinghh/helicon/commits) |
| Issues | [![Issues](https://img.shields.io/github/issues/HarjjotSinghh/helicon.svg?label=open)](https://github.com/HarjjotSinghh/helicon/issues) [![Closed issues](https://img.shields.io/github/issues-closed/HarjjotSinghh/helicon.svg?label=closed)](https://github.com/HarjjotSinghh/helicon/issues?q=is%3Aissue+is%3Aclosed) |
| Pull requests | [![PRs](https://img.shields.io/github/issues-pr/HarjjotSinghh/helicon.svg?label=open)](https://github.com/HarjjotSinghh/helicon/pulls) [![Merged PRs](https://img.shields.io/github/issues-pr-closed/HarjjotSinghh/helicon.svg?label=merged)](https://github.com/HarjjotSinghh/helicon/pulls?q=is%3Apr+is%3Amerged) |
| Code | [![Languages](https://img.shields.io/github/languages/top/HarjjotSinghh/helicon.svg)](#architecture) [![Repo size](https://img.shields.io/github/repo-size/HarjjotSinghh/helicon.svg?label=repo)](https://github.com/HarjjotSinghh/helicon) |

The charts and counts come from GitHub and refresh on their own; nothing here is generated by a bot committing to the repo.

## License

[MIT](LICENSE) © 2026 Harjot Singh Rana and contributors.
