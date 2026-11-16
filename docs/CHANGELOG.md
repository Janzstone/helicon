# Changelog

## 0.23.3

### New

- **Up brings back your last prompt** ([#247](https://github.com/HarjjotSinghh/helicon/pull/247)). Press Up in an empty composer and the thread's most recent prompt fills in, ready to edit and send again, the same as in the `muse` CLI.

### Fixed

- **Long threads no longer freeze** ([#240](https://github.com/HarjjotSinghh/helicon/pull/240), fixes [#32](https://github.com/HarjjotSinghh/helicon/issues/32)). Helicon copied every item in a thread for each new batch of updates, so a thread with a large plan or many subagents could hang. It no longer copies the whole thread each time.
- **A prompt no longer shows twice after a reload** ([#240](https://github.com/HarjjotSinghh/helicon/pull/240), fixes [#55](https://github.com/HarjjotSinghh/helicon/issues/55)). When a thread reloaded while a prompt was sending, the local copy stayed next to the real one.
- **Threads started in the `muse` CLI show up in the sidebar** ([#237](https://github.com/HarjjotSinghh/helicon/pull/237), refs [#50](https://github.com/HarjjotSinghh/helicon/issues/50)). Subagent rows used up the discovery limit, so recent CLI threads never reached the sidebar. Only the threads Helicon keeps count toward the limit now.

## 0.23.2

### Fixed

- **Web links in VS Code replies open again** ([#261](https://github.com/HarjjotSinghh/helicon/pull/261), fixes [#260](https://github.com/HarjjotSinghh/helicon/issues/260)). Clicking a link in a reply inside the VS Code extension now opens it in your browser.
- **Muse in WSL runs in the right distro** ([#263](https://github.com/HarjjotSinghh/helicon/pull/263)). Helicon found Muse in WSL's default distro but launched it in one named Ubuntu, so a path found in one distro ran in the other and failed. Muse now runs where it was found, and `HELICON_WSL_DISTRO` pins a distro such as `Ubuntu-24.04`.

### Changed

- **Muse Code SDK 1.4.20** ([#264](https://github.com/HarjjotSinghh/helicon/pull/264), closes [#243](https://github.com/HarjjotSinghh/helicon/issues/243) and [#250](https://github.com/HarjjotSinghh/helicon/issues/250)), up from 1.4.14. Messages from another session and notices from Muse get their own rows, and a Computer Use takeover approval names the session that holds it.

## 0.23.1

### New

- **Paste images in VS Code** ([#251](https://github.com/HarjjotSinghh/helicon/pull/251), fixes [#249](https://github.com/HarjjotSinghh/helicon/issues/249)). Cmd+V or Ctrl+V with a screenshot on the clipboard now attaches it to the composer in the VS Code extension, the same as in the browser.
- **A DMG for each Mac chip** ([#238](https://github.com/HarjjotSinghh/helicon/pull/238)). Each release now has an Apple Silicon DMG and an Intel DMG next to the universal one. The download page picks the one that fits your Mac.
- **Computer Use approvals name the data they send** ([#254](https://github.com/HarjjotSinghh/helicon/pull/254)). When a step would send a token or a secret, the card shows a warning row for it, such as "Sends a GitHub token ghp_…3f9a".

### Changed

- **Muse Code SDK 1.4.14** ([#254](https://github.com/HarjjotSinghh/helicon/pull/254), closes [#253](https://github.com/HarjjotSinghh/helicon/issues/253) and [#255](https://github.com/HarjjotSinghh/helicon/issues/255)), up from 1.4.12. A session Muse has pruned opens with an "Earlier messages" row listing what it kept. When the safety reviewer sends an approval to you, the card says why.

## 0.23.0

### New

- **Computer Use approvals show what will happen** ([#246](https://github.com/HarjjotSinghh/helicon/pull/246)). Before you approve, the card shows the page's host, the window title and each step, such as Click button "Save" or Press Enter. A host that looks like another one gets a warning.
- **Background commands that finish after a reply** ([#245](https://github.com/HarjjotSinghh/helicon/pull/245)). When a command the agent left running ends, the thread shows a row saying how it ended. Click it to see the output. The turn's reply stays where it was.
- **Linux .deb and .rpm packages** ([#227](https://github.com/HarjjotSinghh/helicon/pull/227)). Ubuntu 22.04 and later ship without libfuse2, so the AppImage did not start there until you installed it. The .deb and .rpm install with your package manager and pull in what they need. The bundled Node.js is now called `helicon-node` on Linux, so it no longer clashes with your own `node`.
- **A SHA-256 for every installer** ([#221](https://github.com/HarjjotSinghh/helicon/pull/221)). Each release now lists the checksums in a `SHA256SUMS` file, and the install guide shows how to check the Windows installer in PowerShell.

### Changed

- **Muse Code SDK 1.4.12** ([#229](https://github.com/HarjjotSinghh/helicon/pull/229) and [#244](https://github.com/HarjjotSinghh/helicon/pull/244)), up from 1.4.10. Helicon hides the new item kinds those versions add, and ignores notifications it does not know yet, so a turn's final reply stays where it was.
- **A smaller first load** ([#216](https://github.com/HarjjotSinghh/helicon/pull/216)). Unused icon weights are gone, and Settings, Usage and What's New load when you open them.
- **Sign-in wording** ([#228](https://github.com/HarjjotSinghh/helicon/pull/228)). Muse Code needs a Meta sign-in or a Model API key. The app, the site and the VS Code listing no longer say the free Muse app covers it.

### Fixed

- **Piped command approvals ask again** ([#192](https://github.com/HarjjotSinghh/helicon/pull/192)). When a piped command reaches a later stage, Helicon now asks you again instead of treating the first answer as covering it.
- **Accessibility** ([#193](https://github.com/HarjjotSinghh/helicon/pull/193) and [#207](https://github.com/HarjjotSinghh/helicon/pull/207)). The sidebar resize handle reports its width to screen readers. Approval and question cards use the right heading level. The model picker's spoken name contains the text you see, including the Contributor badge. The dark-theme accent now has enough contrast under white button text.
- **New Thread during a cold start in VS Code** ([#198](https://github.com/HarjjotSinghh/helicon/pull/198)). If you ran New Thread while the panel was still starting, the request was dropped. The panel now opens on the new thread once it loads.
- **Window listeners and demo file sizes** ([#196](https://github.com/HarjjotSinghh/helicon/pull/196)). A failed window listener is now logged instead of going unhandled, and a file you edit in the web demo shows its new size.

## 0.22.3

### New

- **A "Sign in to Muse" card on native Windows** ([#184](https://github.com/HarjjotSinghh/helicon/pull/184)). Helicon now reads Muse's sign-in file on Windows, the same as on macOS and Linux. When nobody is signed in, the card shows there too. WSL behaves as before.

### Changed

- **Muse Code SDK 1.4.10** ([#183](https://github.com/HarjjotSinghh/helicon/pull/183)), up from 1.4.9.

### Fixed

- **A declined retract keeps its turn** ([#183](https://github.com/HarjjotSinghh/helicon/pull/183), closes [#163](https://github.com/HarjjotSinghh/helicon/issues/163) and [#166](https://github.com/HarjjotSinghh/helicon/issues/166)). Muse 1.4.10 can report that it declined to retract a turn. Helicon folded that turn away anyway, though the prompt still stood. The turn now stays in view.
- **A META_API_KEY counts as signed in** ([#184](https://github.com/HarjjotSinghh/helicon/pull/184)). Muse runs without a sign-in file when META_API_KEY is set, so Helicon no longer asks that user to sign in.

## 0.22.2

### New

- **A "Sign in to Muse" card before your first prompt** ([#159](https://github.com/HarjjotSinghh/helicon/pull/159)). On macOS and Linux, Helicon said "Muse ready" as soon as it found the muse command, even if `muse login` had never run, so a new user only learned they weren't signed in when the first prompt failed. Helicon now reads Muse's sign-in file. When nobody is signed in, the home screen shows the `muse login` command with a Check again button, and the sidebar status says "Sign in to Muse". Windows and WSL behave as before.

### Fixed

- **Muse found right after you install it** ([#159](https://github.com/HarjjotSinghh/helicon/pull/159)). On macOS and Linux, Check again looked only on the PATH Helicon started with. The Muse installer creates `~/.local/bin`, so a fresh install stayed "not found" until you restarted Helicon. Helicon now also looks in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`.
- **Narrow windows** ([#160](https://github.com/HarjjotSinghh/helicon/pull/160)). Below 768 px wide, the sidebar squeezed the page into a thin strip. It now hides by itself on narrow windows and opens over the page, with a backdrop that closes it. It also closes when you pick a thread or page, and it comes back when the window is wide again.
- **Faster start on Windows** ([#155](https://github.com/HarjjotSinghh/helicon/pull/155)). The desktop server now starts while the window is still being built, instead of waiting for WebView2's first start, which can take a few seconds.
- The welcome screen's folder example is now `~/code/my-app`, the same as the Add Project dialog, in place of a Linux-only path ([#159](https://github.com/HarjjotSinghh/helicon/pull/159)).

## 0.22.1

### New

- **A notice while Muse's auto-reviewer checks an action** ([#150](https://github.com/HarjjotSinghh/helicon/pull/150), closes [#149](https://github.com/HarjjotSinghh/helicon/issues/149)). Muse Code 1.4.9 can hold an action while its own auto-reviewer looks at it. Helicon showed nothing during that wait. The approval area now says "Auto-review is checking an action", and the notice clears when Muse hands the action to you or settles it.
- **Muse's labels for unfamiliar tools** ([#150](https://github.com/HarjjotSinghh/helicon/pull/150)). A tool Helicon has no wording of its own for now shows the label Muse 1.4.9 sends, with one label while it runs and another when it finishes. Tools without a label keep the old text.

### Changed

- **Muse Code SDK 1.4.9** ([#148](https://github.com/HarjjotSinghh/helicon/pull/148), [#150](https://github.com/HarjjotSinghh/helicon/pull/150)), up from 1.4.7.

### Fixed

- **Enter while typing Chinese, Japanese or Korean** ([#151](https://github.com/HarjjotSinghh/helicon/pull/151), closes [#143](https://github.com/HarjjotSinghh/helicon/issues/143)). Pressing Enter to pick an input method candidate sent the message or ran the action. Enter and Escape now do nothing while the input method is composing, and for 100 ms after it commits, because the macOS app's WebKit reports the key after the commit. This covers the composer, search boxes, rename and title fields, the Add Project and SSH forms, question answers and the command palette.

## 0.22.0

### New

- **Keep, undo and review a thread's file changes** ([#140](https://github.com/HarjjotSinghh/helicon/pull/140), closes [#94](https://github.com/HarjjotSinghh/helicon/issues/94)). The files-changed card above the composer now has Keep, Undo and Review. Keep accepts a file's changes and hides it from the card until the thread edits it again. Undo reverses the thread's edits to a file, or to every file with Undo all. Helicon re-applies each recorded edit backwards on the current file, and refuses the undo if any edit no longer matches exactly once, so a file you changed since is never overwritten. A file the thread created is deleted only if it still has the content Muse wrote and git does not track it. Review expands the diffs inside the card. Edits made with patches or `replace_all` cannot be undone from the record, and SSH projects have no undo buttons. Muse is not told about an undo.
- **LaTeX in messages** ([#141](https://github.com/HarjjotSinghh/helicon/pull/141), closes [#93](https://github.com/HarjjotSinghh/helicon/issues/93)). Math now typesets with KaTeX: `$x$`, `$$` blocks, `\(x\)` and `\[x\]`. A `$` opens a formula only when no space follows it and the closing `$` is not followed by a digit, so a sentence like "costs $5 and $10" stays text. Code is left alone. A `$$` block that is still streaming shows as plain text until it closes. KaTeX loads as its own chunk the first time a message holds a formula.
- **Resume a paused workflow run** ([#138](https://github.com/HarjjotSinghh/helicon/pull/138)). A paused run has a Resume run button next to Cancel run. Muse Code 1.4.6 added the `workflow/resume` call it uses.

### Changed

- **Muse Code SDK 1.4.7** ([#138](https://github.com/HarjjotSinghh/helicon/pull/138)), up from 1.4.4.

### Fixed

- **Sign-in guidance for `:auto-review` threads** ([#139](https://github.com/HarjjotSinghh/helicon/pull/139), closes [#95](https://github.com/HarjjotSinghh/helicon/issues/95)). On a host with no Muse sign-in, opening or resuming a thread started with the `:auto-review` profile showed Muse's raw "retained session refused" error. It now says to run `muse login`, with a copy button and a link to the guide, and keeps the raw message below.

## 0.21.9

### Fixed

- **New threads run on the model you picked** ([#134](https://github.com/HarjjotSinghh/helicon/pull/134)). A new thread ran on Muse's own default model whatever the picker showed, Muse Wonder included. Muse 1.4.6 takes a model when a session starts but does not use it, so Helicon now sets the model on the new session right after starting it. A new thread with no saved choice starts on the model the picker shows, which is the default in Muse's model list.

## 0.21.8

### New

- **Muse Wonder in the model picker** ([#131](https://github.com/HarjjotSinghh/helicon/pull/131)). Meta released Muse Wonder on 12 October. The Meta API already serves `muse-wonder-1.0` and its contributor tier, but Muse's model list does not include them yet, and Helicon's picker only showed what that list returned. The picker now offers both at the top, and a thread switched to Muse Wonder runs on it. Once Muse lists Wonder itself, its own entry replaces these. Muse Wonder Full is not in the picker yet, because its model id could not be checked. No price is shown for Wonder until Meta publishes one.
- **What's new after an update, in every host** ([#125](https://github.com/HarjjotSinghh/helicon/pull/125)). The notes used to appear only in the desktop app, as a full modal. Now a small card at the top of the toasts lists a few headlines from the built-in changelog, with a link to the full notes, in the desktop app, the browser and the editor extension. Nothing is sent anywhere.

## 0.21.7

### Fixed

- **A signed-out first turn says to sign in** ([#123](https://github.com/HarjjotSinghh/helicon/pull/123)). Muse Code starts without credentials, so a new user who never signed in only found out when their first turn failed, with an error that pointed to `/login`, a command Helicon does not have. The turn now says "Sign in to Muse Code first", shows `muse login` with a copy button and a link to the sign-in guide, and keeps Retry so you can send the turn again once you are signed in.

### Changed

- **Safer editor extension** ([#122](https://github.com/HarjjotSinghh/helicon/pull/122)). The VS Code extension now also checks where a command message comes from, and drops any that do not come from Helicon's own panel, so a page the panel was navigated to cannot open files or read the clipboard.

## 0.21.6

### New

- **Import OMP usage** ([#112](https://github.com/HarjjotSinghh/helicon/pull/112), thanks to Amin, [@aminamos](https://github.com/aminamos), closes [#110](https://github.com/HarjjotSinghh/helicon/issues/110)). OMP sessions that use the `muse-code` provider bill the same Muse plan, but never pass through Helicon, so the Usage page missed them. The Usage page now has an Import OMP button that reads your local OMP sessions (`~/.omp/agent/sessions`, or `PI_CODING_AGENT_DIR`) and adds their calls. Importing again only adds new calls, and the imported sessions stay out of the sidebar.

### Fixed

- **The plan card shows <1% instead of 0%** for a window Muse has reported use in ([#118](https://github.com/HarjjotSinghh/helicon/pull/118), [#26](https://github.com/HarjjotSinghh/helicon/issues/26)). Muse sends whole percentages, so a little use read as "0% used". The card and the sidebar pill now say <1% until the window resets, and the card notes that Meta's usage dashboard can read higher.

### Changed

- **Safer embedding** ([#120](https://github.com/HarjjotSinghh/helicon/pull/120)). The interface only talks to the page that embeds it, ignores messages from any other origin, and drops unsafe theme values. The server tells browsers which pages may frame it (the editor extension and Helicon itself); `--frame-ancestor` adds others, for example a self-hosted code-server.

## 0.21.5

### New

- **Keep threads live when Muse goes quiet** ([#104](https://github.com/HarjjotSinghh/helicon/pull/104), thanks to Nicholas Tindle). Muse can stop pushing updates for a session while its turns keep running, which froze the thread on a spinner and later said it had stopped receiving updates ([#42](https://github.com/HarjjotSinghh/helicon/issues/42)). With "Keep threads live when Muse goes quiet" on (Settings, off by default), Helicon reads the session forward itself and shows what was missed, and checks a quiet turn against Muse's own record so a long command is not taken for a stall.

### Fixed

- **A side chat looks like a new chat.** It used to show every turn and file edit of the thread it came from, as if they were its own. It now shows only its own turns, under a row that says Muse can see the thread it came from and links back to it. Muse still reads that thread, so you can ask about it.
- **A side chat of a side chat** is titled "X (side chat)", not "X (side chat) (side chat)".
- **`/side` with a message never sends into a side chat with the wrong permissions.** If Helicon cannot give the side chat its thread's permissions, it opens the side chat without sending and says so, so you can set them first.
- **Opening a thread mid-turn no longer shows its tool calls as failed** ([#54](https://github.com/HarjjotSinghh/helicon/issues/54)). They stayed failed even after they finished.

## 0.21.4

### New

- **Side chats.** Type `/side` in a thread to open a side chat next to it: a separate chat for a quick question that adds nothing to the thread. Put a message after it, as in `/side what does this regex do?`, and it is sent there. Side chats sit under their thread in the sidebar, joined by a tree line, and the thread shows a Side chat row that opens it. A side chat gets its thread's permissions, though Muse Code opens it with full access ([#116](https://github.com/HarjjotSinghh/helicon/issues/116)).
- **Pause a workflow run.** A running workflow card has a Pause run button next to Cancel run. A paused run shows Paused and can still be cancelled; ask Muse to resume it. The details sheet also shows the run's token budget when it has one.

### Fixed

- **Menus stay next to their button when the interface is zoomed.** In the browser and the editor panel, at any zoom other than 100%, dropdowns and popovers such as the model, effort and permissions menus opened down and to the right of their button. They now open right under it.
- **A paused workflow run shows as Paused,** not as finished or failed, with its agents still counted as working.
- **A deleted project folder says so** ([#105](https://github.com/HarjjotSinghh/helicon/issues/105)). Opening a thread whose folder no longer exists used to fail with "Could not start Muse: Error: write EPIPE". It now names the folder and says to recreate it (an empty folder is enough to open its threads again) or remove the project.

### Changed

- **Up to date with Muse Code 1.4.4.** Helicon now uses version 1.4.4 of the Muse Code SDK.

## 0.21.3

### New

- **Pin threads to the top** ([#111](https://github.com/HarjjotSinghh/helicon/pull/111), by [@aminamos](https://github.com/aminamos)). Pin thread in a thread's menu keeps it above the others in its project, in the sidebar and the command palette, the same way pinned projects work. Pinned threads are never settled automatically; settle one yourself and it keeps its pin for when you bring it back ([#107](https://github.com/HarjjotSinghh/helicon/issues/107)).
- **Enter can steer the running turn** ([#108](https://github.com/HarjjotSinghh/helicon/pull/108), by [@aminamos](https://github.com/aminamos)). Turn on **Settings → Composer → Enter steers the turn** and, while Muse is working, Enter steers the turn and Cmd/Ctrl+Enter queues the message. The placeholder, the send button and the hint follow. Off by default, so Enter still queues ([#106](https://github.com/HarjjotSinghh/helicon/issues/106)).

### Fixed

- **The editor panel is no longer blank when setup is unfinished.** If the muse CLI is missing or Helicon's server can't be reached, the VS Code and Cursor panel now shows the same setup and error screens as the desktop app, with Check again and Try again.
- **The macOS and Linux setup screen tells you how to install Muse Code.** It gives Meta's install command to copy, says a Muse Code plan is needed, and links to the guide for a CLI that's installed but not found.
- **Signed out of Muse? It stays on screen.** When Muse can't start, usually because the muse CLI isn't signed in, a card above the composer shows `muse login` to copy, a Try again button and a link to more fixes, instead of a toast that disappears. The server error screen also links to a prefilled bug report.
- **Usage says "1 call", not "1 calls"** ([#114](https://github.com/HarjjotSinghh/helicon/pull/114), by [@amanrock1](https://github.com/amanrock1)). The call counts on the Usage page, and the line about calls with no published price, agree with their number ([#68](https://github.com/HarjjotSinghh/helicon/issues/68)).

### Changed

- **Install instructions that match what you'll see.** On macOS 15 and later, right-click then Open no longer gets past Gatekeeper, so the site, README and release notes now say: open Helicon once, click Done, then **System Settings → Privacy & Security → Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Helicon.app`). The Windows installer is not code signed yet, so the site no longer calls it signed and says what to do if SmartScreen warns: **More info → Run anyway**. The macOS and Linux steps now start with installing the muse CLI.

## 0.21.2

### New

- **Helicon is in your editor too.** The desktop app's sidebar now mentions the VS Code and Cursor extension, with links to both stores. Close the note and it stays closed. It never shows inside the editor itself.

### Changed

- **The extension is easier to find.** It's listed as "Helicon: Muse Code GUI (unofficial)", so searching "muse code" in the Extensions panel finds it.

## 0.21.1

### Changed

- **Up to date with Muse Code 1.4.** Helicon now uses version 1.4.2 of the Muse Code SDK; it was still on 0.1. It speaks the same protocol version as current Muse Code releases, so the protocol mismatch warning no longer appears.

## 0.21.0

### Changed

- **Better with VoiceOver and other screen readers.** These fixes come from a detailed VoiceOver review of the desktop app:
  - Focus stays in the thread you're in. After you answer an approval or a question, or press Stop, focus returns to the composer instead of the top of the window. Moving to the next of Muse's questions puts focus on its first option ([#96](https://github.com/HarjjotSinghh/helicon/issues/96), [#97](https://github.com/HarjjotSinghh/helicon/issues/97)).
  - The thread no longer rebuilds itself when a turn finishes. The reply you're reading keeps its place, and the steps behind it fold away in place instead of being redrawn. To keep those steps listed, turn on **Settings → Appearance → Keep work expanded** ([#98](https://github.com/HarjjotSinghh/helicon/issues/98)).
  - Status is announced once per change instead of every second. You hear when Muse starts, needs your approval or an answer, finishes a plan step, and finishes, fails or stops. The timer and speed readouts are no longer read out, and running steps no longer announce "Running" ([#99](https://github.com/HarjjotSinghh/helicon/issues/99)).
  - Each thread is a labelled region ("Thread: …") containing a Conversation region and a Composer region, so the VoiceOver rotor can jump between them.
  - Changing threads is always announced ("Opened thread …"), however it happens, and the composer is labelled with the thread a message would go to. Option+Up and Option+Down no longer switch threads when pressed with Control, VoiceOver's own keys ([#103](https://github.com/HarjjotSinghh/helicon/issues/103)).
  - The model picker and the other menus of choices open on the option in use and read it as "selected" ([#100](https://github.com/HarjjotSinghh/helicon/issues/100)).
  - Plan steps read as one item each, for example "Done: Add the route", without extra image stops ([#101](https://github.com/HarjjotSinghh/helicon/issues/101)).
- **Cmd+N for a new thread and Cmd+, for Settings**, also listed in the menu bar (File → New Thread, Helicon → Settings…). Cmd+Shift+O still starts a new thread too ([#102](https://github.com/HarjjotSinghh/helicon/issues/102)).

## 0.20.0

### New

- **Muse Code's monitors, in view.** Muse Code 1.4 can watch something in the background (a pull request's checks, a build, a log) and wake up when there's something to act on, without spending model calls while it waits. Try "open the PR, watch the checks, and fix anything that fails." Helicon now shows it:
  - A thread that's done but still watching shows an eye and "Watching in the background" in the sidebar, the tabs and the command palette, even before you open it.
  - Above the composer, a Watching card lists each monitor with what it watches, the command, and how long it's been running, with a Stop button. Muse replies once to confirm when a monitor stops.
  - In the transcript, the monitor reads "Watching …", and a turn a monitor started is marked "Woken by a monitor", since there's no prompt above it.

  Works in the desktop app and the VS Code / Cursor extension. Scheduled prompts (`/loop`) can't be driven from outside the terminal yet; Helicon will show them once Muse Code allows it.

## 0.19.0

### New

- **Helicon for VS Code, Cursor, Windsurf and Antigravity.** Helicon is now an editor extension too: install it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=harjjotsinghh.helicon) or [Open VSX](https://open-vsx.org/extension/harjjotsinghh/helicon), or search "helicon" in your editor's extensions panel. It opens a side panel for the folder you have open, built for a narrow column: the threads you have open as tabs across the top, History for every earlier thread in the folder (searchable, grouped by day), and the composer at the bottom. It takes on your editor's theme and font, file links in replies open in editor tabs, and copy and paste go through the editor's clipboard. The full app, with every project, is one command away in an editor tab. It runs Helicon's server on your editor's own runtime, so the install is about 1 MB. In Remote-SSH and WSL windows it runs next to your code; that setup is less tested, so please report anything that breaks.
- **The files a thread changed, above the composer.** A card lists every file the thread has edited, with its added and removed lines and a total. Click a file to open it. Fold the card away and it stays folded for that thread. Keeping or undoing changes from here is planned in [#94](https://github.com/HarjjotSinghh/helicon/issues/94).

### Changed

- **Adding a folder shows it straight away.** Adding a project also lists its past threads through Muse, which can take several seconds; the project now appears first and its threads fill in when Muse answers.

## 0.18.0

### New

- **Projects on another machine, over SSH** ([#56](https://github.com/HarjjotSinghh/helicon/pull/56), by [@dinhvh](https://github.com/dinhvh)). Add project has a new source, SSH host: type `host` or `user@host`, browse that machine's folders, and add one as a project. Its threads run Muse on the remote machine over `ssh`, so the code never has to leave it. It needs `ssh <host>` to already work without a password (a key or an agent); port, user and key come from your SSH config. On Windows, Helicon uses Windows' own `ssh.exe`, so keys and config live in `%USERPROFILE%\.ssh`, not in WSL. SSH projects always use the Muse login on the remote machine, so the account picker is hidden for them, and their threads keep the first message as the title instead of asking your local login for one. The file viewer, the skills list, file attachments (images still work), creating folders and cloning are not available for SSH projects yet. When the connection fails, the error now says why: an unknown host key, a login that needs a password, or `ssh` not installed.

### Also

- The helicon.sh 404 page has a "Skip to content" link, and the demo video player now has a name and reads its position as a time for screen readers ([#87](https://github.com/HarjjotSinghh/helicon/pull/87), by [@GhostCoder6969](https://github.com/GhostCoder6969)).
- Contributors can run the whole interface without Muse: `npm run dev:demo --workspace @helicon/web` uses sample projects and threads. See [CONTRIBUTING.md](https://github.com/HarjjotSinghh/helicon/blob/prod/CONTRIBUTING.md).

## 0.17.1

### Fixed

- **A message you sent no longer shows up twice** ([#55](https://github.com/HarjjotSinghh/helicon/issues/55), reported by [@transformingegg](https://github.com/transformingegg)). When a thread reloaded while your message was on its way, the reload showed both the copy from Muse's history and Helicon's own local copy of it, so the same message appeared twice. The local copy is now dropped once the history has it. If you still see a message three times, or Muse answering the same message more than once, please add to the issue.

## 0.17.0

### Changed

- **New icons, one set everywhere** ([#16](https://github.com/HarjjotSinghh/helicon/issues/16)). Helicon now uses [Phosphor](https://phosphoricons.com) icons throughout, the same family as the website, so the app, the web build and the live demos on helicon.sh finally match. Every icon keeps its meaning and place; they are slightly rounder and a touch more solid. The stop button is a filled square, and the Windows, macOS, Linux and GitHub marks on the site come from the same set.

## 0.16.1

### Fixed

- **A turn waiting on your answer is no longer treated as stuck** ([#54](https://github.com/HarjjotSinghh/helicon/issues/54), reported by [@ntindle](https://github.com/ntindle)). When Muse asked a question and you took more than a minute or so to answer, Helicon read the quiet as a dead connection: it reloaded the thread twice, then said the thread had stopped receiving updates, and could show the turn as failed even though it carried on as soon as you answered. A thread waiting on a question or an approval is now left alone for as long as it waits.

## 0.16.0

### New

- **More than one Muse login** ([#45](https://github.com/HarjjotSinghh/helicon/issues/45)). Settings has an Accounts panel: add a named profile, rename it, remove it, and sign in to it without leaving the app. Helicon runs `muse login` under that profile and shows you the device link and code; when Muse runs in WSL it gives you the one command to run in a terminal instead. Each project remembers which account its new threads start on, set from a picker beside the model picker, and threads running under a named profile carry a small chip in the sidebar. The usage page shows a plan meter per account, and when the account you are about to use is near its cap and another has room, the new-thread screen says so; nothing switches on its own. Profiles are managed by [aonia](https://github.com/HarjjotSinghh/aonia), so the CLI still owns every login and Helicon stores no credentials. If `META_API_KEY` is set, every profile inherits it and shares one login, and Settings warns you. With no profiles configured, nothing changes.
- **YOLO mode** (built by [@margantcovka](https://github.com/margantcovka) in [#46](https://github.com/HarjjotSinghh/helicon/pull/46)). One switch for the full `muse --yolo` posture: no approvals, no sandbox, trusted workspace. It sits in the permissions menu and in Settings, behind a confirmation. Approvals turn off for every open thread at once; the sandbox part applies to new threads only, for the same reason as the sandbox switch in 0.15.0. Switching it off restores the modes you had before.

### Fixed

- **Refreshing threads also refreshes plan usage** ([#50](https://github.com/HarjjotSinghh/helicon/issues/50), fixed by [@aminamos](https://github.com/aminamos) in [#51](https://github.com/HarjjotSinghh/helicon/pull/51)). The refresh button re-read your sessions but not your usage, so work done in the terminal never moved the meter until something else did.

## 0.15.0

### New

- **Muse's sandbox can be switched off** ([#34](https://github.com/HarjjotSinghh/helicon/issues/34), built by [@orkuhh](https://github.com/orkuhh) in [#35](https://github.com/HarjjotSinghh/helicon/pull/35)). Muse runs shell commands inside an operating-system sandbox, which on Windows blocks a lot of ordinary work. Settings now has a switch to turn it off, behind a confirmation that says plainly what you are giving up. Turning it on or off restarts Muse in the background; anything mid-turn stops and says so, and threads pick up again on their next use.

  It applies to new threads only, and that is Muse's rule rather than a shortcut here: Muse fixes each thread's sandbox when the thread is created and nothing can change it afterwards. A thread created while the sandbox is off stays that way even after you turn it back on, so those threads carry a "Sandbox off" badge in the sidebar, the thread header and the command palette.

## 0.14.3

### Fixed

- **A thread that stops receiving updates says so** ([#42](https://github.com/HarjjotSinghh/helicon/issues/42), reported by [@margantcovka](https://github.com/margantcovka)). When a turn's live updates go quiet, Helicon reloads the thread's history twice to catch up. If that does not move the turn on, it used to leave a spinner turning for ever. It now says the thread stopped receiving updates, explains that Muse is probably still working, and offers a reload.

### Changed

- **Helicon can now say whether a thread went quiet or was simply idle.** A long report of turns finishing while their view stood still could not be diagnosed, because nothing here recorded anything about the feed of updates. Each session now tracks when it last received one and what it received, frames the protocol refuses are recorded instead of vanishing, and updates that arrive without a session to belong to are counted rather than dropped in silence. All of it reads from `/api/health`. Nothing new leaves your machine: this is written to the local daemon and stays there.
- **One bad update can no longer take down every thread at once.** Handling an update ran unguarded inside the connection's read loop, so a single failure would have ended the connection to Muse and every thread on it. A failure is now contained to the update that caused it.

## 0.14.2

### Fixed

- **A thread stops freezing part-way through a long run** ([#32](https://github.com/HarjjotSinghh/helicon/issues/32), found and fixed by [@margantcovka](https://github.com/margantcovka) in [#41](https://github.com/HarjjotSinghh/helicon/pull/41)). 0.13.1 fixed one cause of this and missed the rest: it still happened with no subagents at all, on a thread of roughly 487 tool calls. Three things were wrong. Reloading a thread while another load was still running threw away every event that arrived in the meantime, so a turn's ending could vanish and the view would show it running for ever. Streaming text, long tool output and very large edits were each re-processed in full on every frame, which stalled the window as a thread grew. And a thread whose stream goes quiet now reloads itself instead of sitting there, which is what restarting the app used to do for you.

## 0.14.1

Same app as 0.14.0 on Windows and macOS. The step that repacks the Linux AppImage without its stale Wayland libraries failed on its first real run, so 0.14.0's AppImage still carried them; it is repacked properly here. Windows and macOS users on 0.14.0 lose nothing by updating.

## 0.14.0

### New

- **Session statistics above the composer** ([#39](https://github.com/HarjjotSinghh/helicon/pull/39), built by [@jorgitin02](https://github.com/jorgitin02)). Two pills summarise the open thread: turns, steps and the request-average speed in one, exact token counts with the cache split and a per-model breakdown in the other. Everything is worked out from the thread's own history on your machine; nothing is sent anywhere. Off by default, switched on under Settings -> Appearance -> Session statistics. On a long thread where only part of the history is loaded, the numbers say so rather than quietly under-reporting: details are marked *Partial* and the token total carries a `+`.

### Fixed

- **The Linux AppImage opens on current distributions** ([#38](https://github.com/HarjjotSinghh/helicon/pull/38), thanks [@orkuhh](https://github.com/orkuhh)). The bundler shipped Ubuntu 22.04's Wayland libraries inside the AppImage, and a newer system's graphics stack could not initialise against them, so the window never appeared ([tauri-apps/tauri#15665](https://github.com/tauri-apps/tauri/issues/15665)). The release now repacks the AppImage without those libraries so it uses the ones already on your system.
- **Two clicks that went to the wrong place** ([#36](https://github.com/HarjjotSinghh/helicon/issues/36), [#37](https://github.com/HarjjotSinghh/helicon/issues/37)). Finishing a sidebar drag no longer opens the thread you dropped, and Alt with the arrow keys no longer jumps threads while you are typing in the composer.

### Changed

- **Short durations read in milliseconds.** A tool call that took under a second used to say "under 1s", which told you nothing; it now says `412ms`.

## 0.13.1

### Fixed

- **A thread that ran subagents no longer grinds to a halt** ([#32](https://github.com/HarjjotSinghh/helicon/issues/32), reported by [@margantcovka](https://github.com/margantcovka)). Applying an event copied the whole thread's state, so each event cost more as the thread grew, and a long one eventually stopped updating while the work carried on without it. Subagent children drove the count, which is why only those threads hung: 20,000 of them took 36 seconds to apply and now take 8 milliseconds. They are also left out of the thread entirely now, since nothing ever showed them.

## 0.13.0

### New

- **Threads get a short generated title** ([#29](https://github.com/HarjjotSinghh/helicon/issues/29), built by [@orkuhh](https://github.com/orkuhh) in [#28](https://github.com/HarjjotSinghh/helicon/pull/28)). The first prompt still names a thread instantly, then one cheap `muse exec` call replaces the echo with a concise title and pushes it back to Muse Code, so the CLI shows the same name. A typed title, or a name Muse Code chose itself, is never touched, and anything that fails leaves the echo in place. Settings has a switch, a model choice, and says plainly that the calls run on your plan; off means no calls at all.

### Changed

- **Back on Settings and Usage returns where you came from** ([#27](https://github.com/HarjjotSinghh/helicon/pull/27), thanks [@orkuhh](https://github.com/orkuhh)), instead of always going home.
- **The desktop app asks helicon.sh for updates**, falling back to GitHub as before. That request is how we count roughly how many installs are in use, since downloads and stars say nothing about that: the platform, the version, and a hash of the IP salted per week, so two weeks of logs cannot be joined. Nothing about your code, prompts or files leaves your machine, and the README and FAQ both say so.
- **"Muse Code" everywhere it means the CLI.** Meta now ships a consumer assistant called Muse for Mac; Helicon is a client for Muse Code and unrelated to it, so the site and README never say bare "Muse" and both disclaimers name the two apart.

## 0.12.6

### New

- **Linux builds.** Releases now carry an x86_64 AppImage, which runs on most distributions and updates itself from then on. Thanks to [@orkuhh](https://github.com/orkuhh) ([#23](https://github.com/HarjjotSinghh/helicon/pull/23)), who also added Ubuntu to CI. A `.deb` will follow: Tauri's Debian bundler would install the bundled Node.js as `/usr/bin/node`, which collides with Debian's own `nodejs` package.

### Fixed

- **A collapsed sidebar can be reopened from Usage and Settings** ([#24](https://github.com/HarjjotSinghh/helicon/pull/24), thanks [@orkuhh](https://github.com/orkuhh)). Those pages draw their own header and had no toggle, so the only ways back were the Back button and Cmd/Ctrl+B.

### Changed

- **Plan usage says how old its numbers are** ([#26](https://github.com/HarjjotSinghh/helicon/issues/26)). Muse reports your plan's allowance with a model call and at no other time, so each row now carries the reading's age, and the card says plainly that the numbers only move when you send a prompt from a thread here. Work done in the terminal counts against the plan without ever reaching this card.

## 0.12.5

Same app as 0.12.4. GitHub refused the macOS update package on every upload attempt for that release, so macOS could not update itself to it; the release job now retries uploads. Windows users on 0.12.4 lose nothing by updating.

## 0.12.4

### Fixed

- **A failed turn's red banner no longer sticks around** ([#22](https://github.com/HarjjotSinghh/helicon/issues/22)). The banner has a close button, and a closed or retried banner stays closed when the thread reloads; before, reopening the thread or restarting the app brought it back. Once the conversation moves past a failed turn, the failure shows as a small "Failed · reason" note in the history instead of a full banner with no way to act on it.

## 0.12.3

### Changed

- **Ultra is gone from the effort picker.** Checked against a real `muse serve` 1.3.0: picking Ultra sends `max` to the model, so it was Max under another name, and the Muse CLI no longer offers it either. Max is now the top of the scale. A thread or setting left on Ultra carries on as Max, and `/effort ultra` still works and means Max.

## 0.12.2

### Fixed

- **Links open in your browser.** Clicking a link in a reply, like a pull request Muse mentions, did nothing in the desktop app. Web and mail links now open in the default browser or mail app, and a link can no longer navigate the Helicon window away. File links still open in the file viewer.

## 0.12.1

### Fixed

- **macOS stops asking for folder access over and over.** The app bundle was not properly signed, so macOS could not remember an Allow and asked again for every project, once for each process Helicon runs. The whole app is now signed as one, so a protected location like Documents asks once. Builds are not yet signed with an Apple Developer ID, so expect one prompt per location again after each update.

### New

- **Close the plan, goal and background-task cards.** Each card above the composer has a close button. A closed card stays hidden in that thread; while one has something to show, a button in the thread's top bar brings it back.

## 0.12.0

### New

- **Muse for Windows, no WSL.** Muse Code now runs natively on Windows, and Helicon runs it that way. When Muse for Windows is installed (`irm https://dev.meta.ai/install.ps1 | iex` in PowerShell), Helicon runs it directly with your Windows paths, runs `!` commands in PowerShell, and never starts WSL. Muse inside WSL2 keeps working: Helicon uses it when native Muse is not installed, and `HELICON_MUSE_RUNTIME=wsl` (or `--runtime wsl` for the web server) keeps WSL when both are. Threads started in WSL live with WSL's Muse, so they stay there. Setup, the sidebar status and Settings show which one is in use.
- **A file viewer beside the thread.** The folder button in the thread's top bar, or Cmd/Ctrl+Shift+E, opens the project's files on the right: a tree you can search by name, tabs, and a resizable panel.
  - Source files show with syntax highlighting and line numbers, and a link to a line range scrolls to and marks it.
  - Markdown opens as a rendered preview, with a toggle to its source, which you can edit and save (Cmd/Ctrl+S). If the file changed on disk since you opened it, Helicon asks before overwriting.
  - Images, video, audio and PDFs preview in place; anything else opens in its default app.
  - File paths Muse mentions in a reply, the files on read, edit and write tool rows, and the changed-file chips under a turn all open in the viewer. A file Muse edits reloads while it is open.
  - The viewer reads and writes only inside the project folder, and serves files so that a page in the project cannot run inside Helicon.

## 0.11.1

### Fixed

- **Dragging a project to reorder the sidebar works again.** The drop marker showed where a project would land, but letting go left the order unchanged, in the desktop app and in the browser alike. The drop handler was reading which project was being dragged from state captured before the drag began, when nothing was.

## 0.11.0

Built on the Muse Session Protocol methods that shipped with Muse Code 1.3.0, each checked against a real `muse serve` host.

### New

- **Plan usage.** The 5-hour window and the weekly cap, as Muse reports them with each model call, with when each resets. A small meter sits in the sidebar footer and a full card leads the usage page. This is your actual allowance, not the API-rate estimate the rest of the usage page shows. (`usage/read`, `usage/changed`)
- **Goal controls.** `/goal <objective>` now sets the goal through Muse's own goal command, which starts work on it straight away. `/goal pause`, `/goal resume` and `/goal clear` work from the composer, and the goal panel has Pause, Resume and Clear. Hosts without the goal commands keep the old behaviour. (`goal/set`, `edit`, `pause`, `resume`, `clear`)
- **Background tasks.** A running tool call can be sent to the background and keeps running while Muse moves on; one running there can be stopped, and a bar above the composer stops every background task in the thread at once. (`task/background`, `task/stop`, `task/stopAll`)
- **Workflow controls.** Cancel a running workflow, and skip or retry one of its agents from the workflow details sheet. (`workflow/cancel`, `workflow/childControl`)
- **Subagent controls.** Message a running subagent, give a finished one a follow-up task, stop, pause, resume, reopen or close it. These appear on subagents that carry a subagent id; Muse Code 1.3.0 does not report one yet (meta-models/muse-code-sdk#13), so they light up once it does. (`subagent/*`)
- **Full tool output.** Output Muse trimmed in the view gets a "Show full output" button that reads the stored log a page at a time. (`item/readOutput`)

### Fixed

- **Reasoning effort now takes effect.** Muse Code 1.3.0 accepts the effort sent with each turn and then drops it before the model call (meta-models/muse-code-sdk#6). Helicon now also sets it as the session's standing default, which Muse does apply, and the effort picker updates the open thread immediately.

### Changed

- **Skills come from the session.** With a thread open, the slash menu lists the skills Muse itself resolves for that session, and refreshes when Muse says they changed; the `muse skills list` CLI call remains for new threads and for reading a skill's instructions. Skills that declare an argument hint show it. (`skill/list`, `skill/changed`)
- **Renames reach Muse.** Renaming a thread renames the Muse session too, so the CLI and `/name` addressing see the same name, and a rename made in another Muse client shows up here. (`session/rename`, `session/nameChanged`)
