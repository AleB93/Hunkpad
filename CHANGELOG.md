# Changelog

All notable changes to Hunkpad are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Fixed

- Line-level staging and the All changes overview did not recognise files whose
  name contains a space (Git adds a tab after such names in diff headers).

## [0.1.0]

First version (as Diffpane), for Windows.
