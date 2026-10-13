# Diffpane

A lightweight Git client for Windows (also macOS/Linux): VS Code-quality diffs
and Source Control features, without running VS Code.

Built with [Tauri 2](https://tauri.app/) (Rust, system WebView2) and the
[Monaco](https://microsoft.github.io/monaco-editor/) diff editor — the same diff
component VS Code uses.

## Features

- **Changes** — staged / unstaged / conflicted files, live refresh via a file
  watcher; stage, unstage, discard per file or all.
- **Line-level staging** — put the cursor in a change (or select lines) and
  *Stage selection*, *Revert selection* or *Unstage selection*.
- **Commit** — commit, amend, "stage all and commit" when nothing is staged.
- **Merge / rebase / cherry-pick / revert in progress** — banner with
  Continue / Skip / Abort; conflicts with Accept current / incoming / Mark resolved.
- **History** — paged log; per commit: changed files with diffs, checkout,
  branch/tag here, cherry-pick, revert, reset (soft/mixed/hard).
- **Branches & tags** — filter (multi-word, Enter checks out a single match),
  favourites (★, per repo, shown first), checkout (incl. remote tracking), create, rename,
  delete, merge, rebase, delete remote branch, push tag.
- **Stashes** — stash (optionally with untracked), apply, pop, drop, view files.
- **Remotes** — list, add, change URL, rename, remove (Branches tab → Remotes,
  ⋯ → Add remote…; Publish offers to add one when there is none). Fetch, pull
  (merge or rebase), push / publish, force push with
  lease, sync (↓ behind ↑ ahead).
- **View: List / Folders / Time** — arranges files inside every section: a
  folder tree (single-child folder chains compacted, collapsible) or buckets by
  last save on disk (last 5 min, 30 min, hour, today, yesterday, 7 days, older)
  with each file's age.
- **Copy for LLM** — plain Markdown (no prompt text): repo/branch/scope header,
  one fenced diff per file with its status, then that file's comments (line,
  open/resolved/outdated, code, text). From the diff toolbar (current diff, or
  everything in the overview), the ⧉ on Staged/Unstaged/Kept local, group and
  file menus, a commit's menu (message + diff) and the Comments tab. Kept local
  files are left out of broad copies (often local secrets).
  By default it copies a **.md file** (Windows clipboard file, like Explorer's copy),
  so pasting into a chat attaches it instead of a wall of text; files live in
  `%TEMP%diffpane-exports` and are deleted after 7 days. ⋯ → "Copy for LLM as:
  file · text" switches to plain text.
- **Review comments** — comment any line on the right side of a diff (hover →
  ＋ in the margin, right-click → Add comment, or Ctrl+Alt+M). Shown under the
  line; a **Comments** tab lists them by file (Open / Resolved / Outdated / All),
  click to jump there. Comments follow their line as code moves and become
  "outdated" when the line is gone. Stored in `.diffpane/`, never committed.
- **Asks before every Git command** that changes something: shows the action,
  the exact command line, what it does (destructive ones in red), the folder and
  any input (e.g. the commit message). Cancel stops the whole action; "Don't ask
  again for the rest of this action" for multi-step actions. Toggle: ⋯ → Ask
  before Git commands.
- **Scripts row** — under the repo tabs, per repository: add an existing script
  (name + where it is) and run it with one click in a new console window, in the
  repo folder (.ps1 PowerShell, .cmd/.bat cmd, .sh Git Bash, .py, .js, else the
  Windows default program). Stored only in the app.
- **Kept local** — files whose changes stay on this machine and are never staged
  or committed (e.g. local settings), without touching `.gitignore`. Excluded from
  Stage all, Discard all, groups and "stage all and commit"; stay listed until
  removed. Stored only in the app.
- **All changes overview** — with no file selected, the diff area lists every
  changed file (Staged, then Unstaged, new files included) showing only its
  changed chunks with 3 lines of context. Click a file or line to open its diff;
  **☰ All changes** or Esc goes back.
- **Change groups (block level, like IntelliJ partial changelists)** — local-only
  "waves" of work. Each unstaged change *block* belongs to a group, so one file
  can be split across groups (badge `2/3`). New blocks go to the **active** group
  (● marker; ⊞ makes a new group active). Blocks keep their group while you keep
  editing them. Move a block from its diff (**Move change ▾**), a file's blocks by
  drag & drop or the row menu. **Commit group** commits only its blocks, built in
  a temporary index in the OS temp folder: other staged work stays staged, hooks
  run. Stored on this machine only; never committed or pushed.
- **Git users** — a first row of tabs (Work, Personal…), each with its own commit
  author name/email and its own repository tabs. The identity is passed as
  `git -c user.name=… -c user.email=…`, so repo config is never written. Move a
  repo between users from its tab menu; a repo belongs to one user.
- **Repository tabs** — one tab per open repo (+ at the end opens a saved
  project), colour per tab (right-click) framing the whole window below the
  tabs (border, tinted toolbar and status bar), Ctrl+Tab / Ctrl+W, tabs restored on
  start. Names, colours and tabs live only in the app, never inside a repo.
- **Projects** — every opened repo is remembered; pin, rename, remove; quick
  picker with search on **Ctrl+R** or by clicking the project name. Starts on
  the last project.
- **Clone**, output log of every Git command, light/dark theme from the OS.

## Where data is stored

- **Per repository**: `<repo>/.diffpane/state.json` — tab colour, favourite
  branches/tags, change groups and block assignments, Kept local list, scripts, comments.
  `.diffpane/.gitignore` contains `*`, so Git ignores the whole folder (itself
  included): it is always kept local and never committed, without touching the
  repository's own `.gitignore`. Created on the first save; data from older
  versions moves there automatically.
- **App-wide** (WebView storage in `%LOCALAPPDATA%dev.diffpane.desktop`): Git
  users, open tabs, saved projects, view mode, "Ask before Git commands".

## Design

The Rust side (`src-tauri/src/lib.rs`) is deliberately thin: it runs `git`,
reads/writes work-tree files and watches the repo. All Git logic is TypeScript
in `src/git.ts`, using the `git` CLI (same approach as VS Code), so it behaves
exactly like Git on the command line, hooks and credential manager included.

## Prerequisites (Windows)

1. Git for Windows on `PATH`.
2. Node.js 20+.
3. Rust: `winget install Rustlang.Rustup`, then open a new terminal.
4. MSVC build tools: Visual Studio Installer → *Desktop development with C++*
   (MSVC + Windows SDK).

## Run

```bash
npm install
npm run tauri dev
```

Open a specific repo: `npm run tauri dev -- -- C:\path\to\repo`.

## Build

Standalone `.exe` only (no installers):

```bash
powershell -ExecutionPolicy Bypass -File scripts/build.ps1
```

or `bash scripts/build.sh` (Git Bash; also for macOS/Linux later). Output:
`src-tauri/target/release/diffpane.exe`.

With installers (MSI + NSIS):

```bash
npm run tauri build
```

Output: `src-tauri/target/release/bundle/` (MSI and NSIS installers).

## Use from your IDE

Register `diffpane.exe "<repo path>"` as an external tool (Visual Studio:
Tools → External Tools, arguments `$(SolutionDir)`). With no argument it
reopens the last repository.

## Known limitations

- Line-level actions are disabled for binary and non-UTF-8 files.
- A change that only adds/removes the final newline cannot be staged by line;
  stage the whole file instead.
- No blame, no graph view, no submodule management yet.
