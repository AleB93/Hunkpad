# Contributing to Hunkpad

Thanks for helping. Bug reports, ideas and pull requests are all welcome; for a
larger change, open an issue first so we can agree on the approach.

## Prerequisites

On every platform: **Git**, **Node.js 20+** and **Rust** (stable, from
[rustup.rs](https://rustup.rs)). Then, per platform:

- **Windows**: Visual Studio Build Tools → *Desktop development with C++*
  (MSVC + Windows SDK). WebView2 is already part of Windows 10/11.
  Rust can be installed with `winget install Rustlang.Rustup`.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`).
- **Linux** (Debian/Ubuntu):

  ```bash
  sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

  Other distributions: see Tauri's
  [prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

## Run

```bash
npm install
npm run tauri dev
```

To open a specific repository: `npm run tauri dev -- -- /path/to/repo`.
Frontend changes reload in place; Rust changes rebuild and restart the app.

## Check

```bash
npm test            # parser tests, against real git output
npm run typecheck   # TypeScript
cd src-tauri && cargo clippy
```

## Build

The app executable only, no installers (`src-tauri/target/release/hunkpad`, or
`hunkpad.exe` on Windows):

```bash
bash scripts/build.sh
```

On Windows without Git Bash: `powershell -ExecutionPolicy Bypass -File scripts/build.ps1`.

Installers for the current platform (Windows: MSI + NSIS; macOS: .app + .dmg;
Linux: .deb, .rpm, .AppImage), in `src-tauri/target/release/bundle/`:

```bash
npm run tauri build
```

Each platform's installers must be built on that platform.

## How it is built

- `src-tauri/src/lib.rs`: the Rust side, deliberately thin. It runs `git`,
  reads and writes work-tree files, watches the repository and stores settings.
- `src-tauri/src/platform.rs`: everything that differs between Windows, macOS
  and Linux (clipboard files, terminal windows for scripts, the login shell's
  PATH, the macOS menu).
- `src/git.ts`: all Git logic, on top of the `git` command line (the same
  approach as VS Code), so Hunkpad behaves exactly like Git in a terminal.
- `src/main.ts`: the UI. `src/platform.ts` holds the frontend's platform
  differences (Cmd vs Ctrl, path case).
- `src/repoStore.ts` (per-repository data in `.hunkpad/`) and `src/settings.ts`
  (app-wide `settings.json`).

Some rules the code follows:

- Every Git command that changes something goes through the "ask before Git
  commands" approver, so the user sees the exact command line.
- Nothing is ever written to a repository's Git config or `.gitignore`.
- Files are only read and written inside repositories (`safe_join` in lib.rs).
- The page runs under a strict Content Security Policy (`tauri.conf.json`):
  no inline scripts and no network access except Tauri's IPC.

## Pull requests

- Keep each PR focused on one change, and describe what you tested on which OS.
- Run the checks above.
- Add an entry under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- If you touch `platform.rs`, say which platforms you could not test.

## Releasing

The version lives in `package.json` only (`tauri.conf.json` reads it from there):

```bash
npm version 0.2.0
```

This also updates `src-tauri/Cargo.toml`, commits and tags `v0.2.0`.
