# Changelog

All notable changes to Hunkpad are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-25

### Added

- Search: Ctrl+P finds a file by name, Ctrl+Shift+F finds text in all files,
  and Ctrl+click (or Shift+F12) on a word lists where it is used.
- Markdown preview: .md files open rendered; links into the repository open in
  Hunkpad, web links in the browser, and repository images show inline.
- Quick actions row: Terminal here, Copy path.
- Claude Code can use Hunkpad over MCP (off by default; one click adds it to
  Claude Code): it sees the open repository, file, cursor and changes, manages
  change groups and comments, opens files, and stages or commits a group after
  you approve the Git command in Hunkpad.
- Top bar with Projects, Search, the Claude Code (MCP) button and a theme
  picker: System, Light, Dark and Retro.
- Comments tab: Resolve all, Reopen all, Copy and Drop all, acting on the
  filtered list.
- Optional Claude features (off by default; ⋯ → Claude features…), run through
  the user's own Claude Code CLI: draft commit messages, organize changes into
  groups, review changes as comments, describe a branch for a pull request,
  explain a commit, and suggest merge-conflict resolutions. Every request is
  shown before it is sent; Kept local and secret-looking files are never sent.
- Git worktrees: the Branches tab lists the repository's worktrees; create one
  (new or existing branch, or detached) from there, from a branch, tag or
  commit, or from ⋯ → New worktree…; open, lock, move, remove and prune them.
  A branch checked out in another worktree opens that worktree instead. Claude Code sees the worktrees over MCP and can
  switch to one. A repository's worktrees share its tab: the Worktree bar under
  the tabs switches between them.
- Worktree setup (⚙ Setup): files Git does not track (e.g. .env) are copied
  from the main folder into each new worktree, then a command runs there
  (pnpm install by default for a Node project). Run setup also works on
  worktrees made elsewhere (e.g. by Claude Code). ✨ Suggest with Claude fills
  it in from the repository's file names and manifests (no untracked file
  contents are sent); Claude Code can read, change and run it over MCP, each
  change approved in Hunkpad.
- Scripts are shared by all of a repository's worktrees and run in the one you
  are on, with HUNKPAD_WORKTREE (its number) and, with a base port, PORT set so
  two dev servers do not collide.

### Fixed

- Under `npm run tauri dev`, consoles started from Hunkpad stay open when the
  app rebuilds.
- A linked worktree now refreshes when it is staged, committed or checked out
  from a terminal (its index and HEAD live outside its folder).

## [0.2.0] - 2026-10-16

### Changed

- Renamed from Diffpane to **Hunkpad** (app ID `io.github.aleb93.hunkpad`). A
  repository's `.diffpane/` folder is renamed to `.hunkpad/` automatically the
  first time it is opened.
- App-wide settings (Git users, projects, tabs, preferences) are now stored in
  `settings.json` in the OS app-data folder, instead of the WebView's storage.

### Added

- macOS and Linux support:
  - Copy for LLM copies a `.md` file on macOS too; on Linux it copies text.
  - Scripts run in a terminal window (Terminal on macOS, the first terminal
    found on Linux), with the interpreter chosen by extension.
  - "Git not found" explains how to install Git on each platform.
  - On macOS, shortcuts use ⌘ and are shown as such; ⌘W closes a repository tab
    instead of the window.
  - When started from the Finder, the Dock or a desktop launcher, the login
    shell's PATH is used, so Git hooks find tools such as node or Homebrew's Git.
  - On Linux, project paths are compared case-sensitively, and hitting the
    file-watch limit shows how to raise it.
- npm scripts in the Scripts row: choose a `package.json` and one of its
  scripts, and it runs with `npm run` in that folder.
- A strict Content Security Policy for the app's page.
- Tests for the Git output parsers, run against real Git.
- Ready-made installers for Windows, macOS (Apple Silicon and Intel) and Linux,
  built by GitHub Actions for each release.
- `npm run demo`: the app in a browser on a generated sample repository (used
  for the screenshots in the README).

### Fixed

- Line-level staging and the All changes overview did not recognise files whose
  name contains a space (Git adds a tab after such names in diff headers).

## [0.1.0]

First version (as Diffpane), for Windows.

[Unreleased]: https://github.com/AleB93/Hunkpad/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/AleB93/Hunkpad/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/AleB93/Hunkpad/releases/tag/v0.2.0
