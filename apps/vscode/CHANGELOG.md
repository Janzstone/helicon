# Changelog

The extension ships the same Helicon as the desktop app. Full notes for every version: [helicon.sh/changelog](https://helicon.sh/changelog).

## 0.23.3

- Press Up in an empty composer to bring back your last prompt (#247).
- Long threads no longer freeze, and a prompt no longer shows twice after a reload (#240).
- Threads started in the muse CLI show up in the sidebar (#237).

## 0.23.2

- Web links in replies open in your browser again (#261).
- Muse inside WSL runs in the distro it was found in, and HELICON_WSL_DISTRO pins one (#263).
- Muse Code SDK 1.4.20. Messages from other sessions and Muse notices get their own rows (#264).

## 0.23.1

- Paste screenshots into the composer with Cmd+V or Ctrl+V (#251).
- Muse Code SDK 1.4.14. Pruned sessions show an "Earlier messages" row, and Computer Use approvals warn about tokens or secrets a step would send (#254).

## 0.23.0

- Linux .deb and .rpm packages next to the AppImage (#227).
- Muse Code SDK 1.4.12 (#229, #244). A smaller first load (#216).
- Computer Use approvals show the host, window and each step before you approve (#246).
- A row for background commands that finish after a reply (#245).
- A later stage of a piped command asks for approval again (#192).
- New Thread opens the new thread when the panel is still starting (#198).
- Accessibility fixes for the resize handle, card headings, the model picker's name and button contrast (#193, #207).

## 0.22.3

- A "Sign in to Muse" card now shows on native Windows too, and a META_API_KEY counts as signed in (#184).
- Muse Code SDK 1.4.10. A turn whose retract Muse declined stays in view (#183).

## 0.22.2

- A "Sign in to Muse" card shows on macOS and Linux when Muse isn't signed in, and Muse is found right after you install it (#159).
- The sidebar floats over the page in narrow panels instead of squeezing it (#160).

## 0.22.1

- A notice shows while Muse's auto-reviewer checks an action, and unfamiliar tools use Muse's own labels (#150).
- Muse Code SDK 1.4.9 (#148, #150).
- Enter no longer sends or runs an action while a Chinese, Japanese or Korean input method is composing (#151).

## 0.22.0

- Keep, undo and review a thread's file changes from the files-changed card (#140).
- Math typesets in messages: `$x$`, `$$` blocks, `\(x\)` and `\[x\]` (#141).
- A paused workflow run has a Resume run button (#138).
- A thread started with the `:auto-review` profile on a signed-out host says to run `muse login` (#139).

## 0.21.9

- New threads run on the model you picked, Muse Wonder included (#134).

## 0.21.8

- Muse Wonder (`muse-wonder-1.0` and its contributor tier) is in the model picker (#131).
- A small What's new card shows after an update, in the editor too (#125).

## 0.21.7

- A signed-out first turn says to sign in to Muse Code, shows `muse login` and keeps Retry (#123).
- The panel drops command messages that do not come from Helicon's own frame (#122).

## 0.21.6

- Import usage from OMP sessions that use the muse-code provider (#112).
- The plan card shows <1% instead of 0% for a window with a little use (#118).
- Safer embedding: the panel only talks to the editor that hosts it (#120).

## 0.21.5

- A side chat shows only its own turns, not a copy of its thread.
- Optional setting to keep threads live when Muse stops pushing updates (#104).
- Opening a thread mid-turn no longer shows its tool calls as failed.

## 0.21.4

- Side chats: `/side` opens a separate chat next to a thread, shown under it in the sidebar.
- Pause a running workflow from its card.
- Menus open right under their button when the panel is zoomed.
- A deleted project folder now says so, instead of "write EPIPE".

## 0.21.3

- The panel shows the setup and error screens instead of staying blank when the muse CLI is missing or the server can't be reached.
- A lasting "Muse could not start" card with `muse login` to copy, instead of a toast that disappears.
- Pin threads, Enter can steer the running turn (opt in), and "1 call" on the Usage page. Thanks [@aminamos](https://github.com/aminamos) and [@amanrock1](https://github.com/amanrock1).

## 0.21.2

- Listed as "Helicon: Muse Code GUI (unofficial)", so searching "muse code" finds it.

## 0.21.1

- Up to date with Muse Code 1.4: uses the 1.4.2 Muse Code SDK.
- A new screenshot of the panel in the listing, and a link to try the full app in your browser first.

## 0.21.0

- Works better with screen readers: status is announced once per change instead of every second, focus stays in the thread after approvals, questions and Stop, and a finishing turn no longer rebuilds the transcript.

## 0.20.0

- Muse Code monitors: a Watching status on threads and tabs, a card with a Stop button for each monitor, and "Woken by a monitor" on the turns they start.

## 0.19.0

- The side panel: threads as tabs, History, the files a thread changed, your editor's theme, file links that open in the editor, and copy and paste that work.

## 0.18.0

- First release of Helicon as an editor extension for VS Code, Cursor, Windsurf and other VS Code-based editors.
