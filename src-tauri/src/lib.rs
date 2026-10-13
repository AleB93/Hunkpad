//! Native side of Hunkpad. Deliberately thin: it runs `git`, reads and writes
//! work-tree files, and watches the repository. All Git logic lives in the
//! TypeScript frontend (src/git.ts).

mod platform;

use std::{
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct WatchState(Mutex<Option<Debouncer<RecommendedWatcher>>>);

#[derive(Serialize)]
struct GitOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Error text the frontend recognises as "Git is missing".
const GIT_NOT_FOUND: &str = "GIT_NOT_FOUND";

/// The git executable in use; found once, re-checked by `git_version`.
static GIT_EXE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Locks a mutex even if a panic elsewhere poisoned it: the data is still usable.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// `git` from PATH, else the usual install folders. The fallback matters right
/// after installing Git (a running app still has the old PATH), and on macOS
/// for Homebrew's Git when the login shell's PATH could not be read.
fn find_git() -> Option<PathBuf> {
    let works = |exe: &Path| {
        hidden(Command::new(exe).arg("--version"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if works(Path::new("git")) {
        return Some(PathBuf::from("git"));
    }
    #[cfg(windows)]
    {
        let mut candidates = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Ok(dir) = std::env::var(var) {
                candidates.push(PathBuf::from(dir).join(r"Git\cmd\git.exe"));
            }
        }
        if let Ok(dir) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(dir).join(r"Programs\Git\cmd\git.exe"));
        }
        if let Some(found) = candidates.into_iter().find(|c| c.is_file() && works(c)) {
            return Some(found);
        }
    }
    #[cfg(not(windows))]
    {
        let candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
        if let Some(found) = candidates.into_iter().map(Path::new).find(|c| c.is_file() && works(c)) {
            return Some(found.to_path_buf());
        }
    }
    None
}

/// The executable to run (detected on first use).
fn git_exe() -> PathBuf {
    let mut cached = lock(&GIT_EXE);
    if cached.is_none() {
        *cached = find_git();
    }
    cached.clone().unwrap_or_else(|| PathBuf::from("git"))
}

/// Looks for Git again (e.g. after installing it) and returns its version
/// ("git version 2.45.2.windows.1"), or None if it is not installed.
#[tauri::command]
fn git_version() -> Option<String> {
    let found = find_git();
    *lock(&GIT_EXE) = found.clone();
    let out = hidden(Command::new(found?).arg("--version")).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Opens Git's download page for this platform in the default browser (only that page).
#[tauri::command]
fn open_git_download() -> Result<(), String> {
    platform::open_url(platform::GIT_DOWNLOAD_URL)
}

/// Opens the page where `host` creates access tokens, for signing a repository
/// in (only these known pages).
#[tauri::command]
fn open_token_page(host: String) -> Result<(), String> {
    let url = match host.as_str() {
        "github.com" => "https://github.com/settings/tokens/new?scopes=repo&description=Hunkpad",
        "gitlab.com" => {
            "https://gitlab.com/-/user_settings/personal_access_tokens?name=Hunkpad&scopes=read_repository,write_repository"
        }
        _ => return Err(format!("no token page known for {host}")),
    };
    platform::open_url(url)
}

fn git_command(cwd: &str) -> Command {
    let mut cmd = Command::new(git_exe());
    cmd.current_dir(cwd)
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        // Never block on a terminal prompt; Git Credential Manager still shows its own window.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Read-only commands (status) must not rewrite .git/index, or the watcher would loop.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Merge / rebase --continue must never wait for an editor.
        .env("GIT_EDITOR", "true")
        // Paths are file names, never globs.
        .env("GIT_LITERAL_PATHSPECS", "1");
    hidden(&mut cmd);
    cmd
}

/// One piece of live output, sent as the `git-output` event while a streamed command runs.
#[derive(Serialize, Clone)]
struct GitLine {
    id: u32,
    stream: &'static str,
    text: String,
    /// Ended with `\r`: a progress update that replaces the previous one.
    progress: bool,
}

/// Reads a pipe to the end and returns everything. With `emit`, also sends each
/// line (split on `\n` and on `\r`, which Git uses for progress) as it arrives.
fn drain<R: Read>(mut pipe: R, emit: Option<(AppHandle, u32, &'static str)>) -> Vec<u8> {
    let mut all = Vec::new();
    let mut pending = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match pipe.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        all.extend_from_slice(&chunk[..n]);
        let Some((app, id, stream)) = &emit else { continue };
        for &b in &chunk[..n] {
            if b == b'\n' || b == b'\r' {
                let text = String::from_utf8_lossy(&pending).into_owned();
                pending.clear();
                let line = GitLine { id: *id, stream, text, progress: b == b'\r' };
                let _ = app.emit("git-output", line);
            } else {
                pending.push(b);
            }
        }
    }
    if let (Some((app, id, stream)), false) = (&emit, pending.is_empty()) {
        let text = String::from_utf8_lossy(&pending).into_owned();
        let _ = app.emit("git-output", GitLine { id: *id, stream, text, progress: false });
    }
    all
}

/// Runs `git <args>` in `cwd`. A non-zero exit code is returned, not raised,
/// so the frontend can decide what is an error.
///
/// `index_file` sets `GIT_INDEX_FILE`, to build a commit in a temporary index
/// (see `temp_index_path`) without touching the repository's real index.
/// `stream_id` streams the output live as `git-output` events tagged with it.
#[tauri::command]
async fn run_git(
    app: AppHandle,
    cwd: String,
    args: Vec<String>,
    stdin: Option<String>,
    index_file: Option<String>,
    stream_id: Option<u32>,
) -> Result<GitOutput, String> {
    if let Some(path) = &index_file {
        check_temp_index(path)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = git_command(&cwd);
        if let Some(path) = &index_file {
            cmd.env("GIT_INDEX_FILE", path);
        }
        let mut child = cmd
            .args(&args)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    GIT_NOT_FOUND.to_string()
                } else {
                    format!("failed to run git: {e}")
                }
            })?;
        if let Some(input) = stdin {
            let mut pipe = child.stdin.take().expect("stdin is piped");
            // Written from another thread so a large stdout cannot deadlock us.
            std::thread::spawn(move || {
                let _ = pipe.write_all(input.as_bytes());
            });
        }
        // Both pipes are drained on their own threads, so neither can fill up and block git.
        let emit = |stream: &'static str| stream_id.map(|id| (app.clone(), id, stream));
        let out_pipe = child.stdout.take().expect("stdout is piped");
        let err_pipe = child.stderr.take().expect("stderr is piped");
        let (out_emit, err_emit) = (emit("out"), emit("err"));
        let out_thread = std::thread::spawn(move || drain(out_pipe, out_emit));
        let err_thread = std::thread::spawn(move || drain(err_pipe, err_emit));
        let status = child.wait().map_err(|e| e.to_string())?;
        let stdout = out_thread.join().unwrap_or_default();
        let stderr = err_thread.join().unwrap_or_default();
        Ok(GitOutput {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

const TEMP_INDEX_PREFIX: &str = "hunkpad-index-";

/// A temporary index must be one of ours: in the OS temp folder, with our prefix.
fn check_temp_index(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ours = p.parent() == Some(std::env::temp_dir().as_path())
        && p
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with(TEMP_INDEX_PREFIX));
    if ours {
        Ok(p)
    } else {
        Err(format!("not a Hunkpad temporary index: {path}"))
    }
}

/// A fresh path for a temporary index, in the OS temp folder (never inside a repo).
#[tauri::command]
fn temp_index_path() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!("{TEMP_INDEX_PREFIX}{}-{nanos}", std::process::id()))
        .to_string_lossy()
        .into_owned()
}

/// Deletes a temporary index (and a leftover `.lock`, if Git was interrupted).
#[tauri::command]
fn remove_temp_index(path: String) -> Result<(), String> {
    let p = check_temp_index(&path)?;
    let _ = std::fs::remove_file(&p);
    let _ = std::fs::remove_file(p.with_extension("lock"));
    Ok(())
}

/// Joins a repo-relative path, rejecting anything that could escape the repo
/// and any `repo` that is not a Git work tree, so files are only read and
/// written inside repositories.
fn safe_join(repo: &str, path: &str) -> Result<PathBuf, String> {
    if !Path::new(repo).join(".git").exists() {
        return Err(format!("not a Git repository: {repo}"));
    }
    let rel = Path::new(path);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("invalid path: {path}"));
    }
    Ok(Path::new(repo).join(rel))
}

/// Returns the work-tree file, or `None` when it does not exist.
#[tauri::command]
async fn read_file(repo: String, path: String) -> Result<Option<String>, String> {
    let full = safe_join(&repo, &path)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read(&full) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", full.display())),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_file(repo: String, path: String, content: String) -> Result<(), String> {
    let full = safe_join(&repo, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        // e.g. the first save into .hunkpad/ creates the folder.
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&full, content).map_err(|e| format!("{}: {e}", full.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The data folder's earlier names (the app was called Diffpane), newest first.
const OLD_DATA_DIRS: [&str; 2] = [".diffpane", ".dspane"];

/// Renames a repository's data folder from an earlier name to `.hunkpad` and
/// returns the old name. Only when `.hunkpad` does not exist yet, so nothing is
/// overwritten.
#[tauri::command]
fn migrate_data_dir(repo: String) -> Result<Option<String>, String> {
    let new = Path::new(&repo).join(".hunkpad");
    if new.exists() {
        return Ok(None);
    }
    let Some(name) = OLD_DATA_DIRS.into_iter().find(|n| Path::new(&repo).join(n).is_dir()) else {
        return Ok(None);
    };
    let old = Path::new(&repo).join(name);
    std::fs::rename(&old, &new).map_err(|e| format!("could not rename {}: {e}", old.display()))?;
    // Its .gitignore still names the old app; it only needs to keep ignoring everything.
    let _ = std::fs::write(new.join(".gitignore"), "# Hunkpad data: local to this machine, never committed.\n*\n");
    Ok(Some(name.to_string()))
}

/// Repository path passed on the command line, e.g. by an IDE external tool.
#[tauri::command]
fn initial_repo() -> Option<String> {
    std::env::args().nth(1)
}

/// Inside `.git`, only files that change what we display are worth a refresh.
/// `.hunkpad` (Hunkpad's own data, ignored by Git) never is: saving it must
/// not trigger a refresh that saves it again.
fn is_relevant(path: &Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.iter().any(|p| p == ".hunkpad" || OLD_DATA_DIRS.contains(&p.as_str())) {
        return false;
    }
    match parts.iter().position(|p| p == ".git") {
        None => true,
        Some(i) => {
            let inside = &parts[i + 1..];
            matches!(
                inside.first().map(String::as_str),
                Some("index" | "HEAD" | "refs" | "packed-refs" | "MERGE_HEAD" | "rebase-merge" | "rebase-apply")
            )
        }
    }
}

/// Linux watches each folder separately (inotify), and big repositories (e.g.
/// with node_modules) can hit the system's limit: say how to raise it.
fn watch_error(e: &str) -> String {
    let limit = cfg!(target_os = "linux")
        && (e.contains("No space left") || e.contains("Too many open files") || e.contains("inotify"));
    if limit {
        format!(
            "cannot watch this repository for changes ({e}): it has more folders than the system allows. \
             Raise the limit, e.g. `sudo sysctl fs.inotify.max_user_watches=524288`; until then press F5 to refresh"
        )
    } else {
        format!("cannot watch this repository for changes: {e}")
    }
}

/// Watches the repository and emits `repo-changed` (debounced) on changes.
#[tauri::command]
fn watch_repo(app: AppHandle, state: State<'_, WatchState>, repo: String) -> Result<(), String> {
    let mut debouncer = new_debouncer(Duration::from_millis(300), move |res: DebounceEventResult| {
        if let Ok(events) = res {
            if events.iter().any(|e| is_relevant(&e.path)) {
                let _ = app.emit("repo-changed", ());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(Path::new(&repo), RecursiveMode::Recursive)
        .map_err(|e| watch_error(&e.to_string()))?;
    // Replacing the previous debouncer drops it, which stops the old watch.
    *lock(&state.0) = Some(debouncer);
    Ok(())
}

/// Last-modified time (ms since the Unix epoch) of each repo-relative path;
/// `None` when the file does not exist (e.g. deleted). File system only, not Git.
#[tauri::command]
async fn file_times(repo: String, paths: Vec<String>) -> Result<Vec<Option<u64>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|p| {
                let full = safe_join(&repo, p).ok()?;
                let modified = std::fs::metadata(full).ok()?.modified().ok()?;
                let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
                Some(since_epoch.as_millis() as u64)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Direct subfolders of `path` that are Git repositories (contain `.git`),
/// suggested when the user picks a folder that is not a repository itself.
#[tauri::command]
fn find_child_repos(path: String) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(&path) else {
        return Vec::new();
    };
    let mut repos: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").exists())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    repos.sort();
    repos
}

/// Writes `content` to `<temp>/hunkpad-exports/<name>` and puts that file on
/// the clipboard, so pasting into a chat attaches it as a file. Exports older
/// than 7 days are deleted first. Returns the file's path.
#[tauri::command]
fn copy_as_file(name: String, content: String) -> Result<String, String> {
    // Only plain file-name characters: no folders, no surprises.
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' })
        .collect();
    let safe = safe.trim_matches(|c| c == '.' || c == '-');
    if safe.is_empty() {
        return Err("empty file name".into());
    }
    let dir = std::env::temp_dir().join("hunkpad-exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    let week = Duration::from_secs(7 * 24 * 3600);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > week);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    let path = dir.join(safe);
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
    platform::copy_file_to_clipboard(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// For each path (relative to `base`, or absolute): whether it exists, as a file
/// or a folder. Used to read Git's state files (e.g. `.git/rebase-merge`).
#[tauri::command]
fn paths_exist(base: String, paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(&base).join(p).exists()).collect()
}

/// Whether `path` is an existing file (used to validate a user script's location).
#[tauri::command]
fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Git for Windows' own bash (not WSL's `bash.exe` from System32), derived
/// from `git --exec-path` = `<git root>/mingw64/libexec/git-core`.
#[cfg(windows)]
fn git_bash() -> Option<PathBuf> {
    let out = git_command(".").arg("--exec-path").output().ok()?;
    let exec = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let bash = exec.ancestors().nth(3)?.join("bin").join("bash.exe");
    bash.is_file().then_some(bash)
}

/// Whether `path` is a file named package.json (an npm script's location).
fn is_package_json(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "package.json") && path.is_file()
}

/// The content of a package.json, for listing its npm scripts.
#[tauri::command]
fn read_package_json(path: String) -> Result<String, String> {
    let path = Path::new(&path);
    if !is_package_json(path) {
        return Err(format!("not a package.json: {}", path.display()));
    }
    std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Starts a user script in a new console (Windows) or terminal window, in `cwd`
/// (the repository). The window stays open afterwards so its output can be read.
/// With `npm`, `script` is a package.json and `npm run <npm>` runs in its folder.
#[tauri::command]
fn launch_script(cwd: String, script: String, npm: Option<String>) -> Result<(), String> {
    let path = Path::new(&script);
    if !path.is_file() {
        return Err(format!("script not found: {script}"));
    }
    if let Some(name) = npm {
        return launch_npm_script(path, &name);
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let quoted = |s: &str| format!("\"{s}\"");
        let mut cmd = if ext == "ps1" {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", &script]);
            c
        } else {
            // cmd /k keeps the window open. The whole command line is wrapped in one
            // extra pair of quotes, which cmd strips, so quoted paths with spaces survive.
            let line = match ext.as_str() {
                "sh" => {
                    let bash = git_bash().ok_or("Git for Windows bash not found")?;
                    format!("{} {}", quoted(&bash.to_string_lossy()), quoted(&script))
                }
                "py" => format!("python {}", quoted(&script)),
                "js" | "mjs" => format!("node {}", quoted(&script)),
                _ => quoted(&script), // .cmd, .bat, .exe and anything with a file association
            };
            let mut c = Command::new("cmd.exe");
            c.raw_arg(format!("/k \"{line}\""));
            c
        };
        cmd.current_dir(&cwd)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("could not start {script}: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    platform::launch_in_terminal(&cwd, &platform::script_command(path, &ext)?)
}

/// `npm run <name>` in a new console or terminal window, in the folder of
/// `package_json`.
fn launch_npm_script(package_json: &Path, name: &str) -> Result<(), String> {
    if !is_package_json(package_json) {
        return Err(format!("not a package.json: {}", package_json.display()));
    }
    let dir = package_json.parent().ok_or("package.json has no folder")?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        if name.contains('"') {
            return Err(format!("unsupported npm script name: {name}"));
        }
        // Same outer quotes as launch_script: cmd strips them, the name keeps its own.
        Command::new("cmd.exe")
            .raw_arg(format!("/k \"npm run \"{name}\"\""))
            .current_dir(dir)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("could not start npm run {name}: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    platform::launch_in_terminal(&dir.to_string_lossy(), &format!("npm run {}", platform::quote(name)))
}

/// Stops watching (when the last tab is closed).
#[tauri::command]
fn unwatch_repo(state: State<'_, WatchState>) {
    *lock(&state.0) = None;
}

/// App-wide settings file (see settings.ts), in the OS app-config folder.
fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// The settings file's content, or `None` before the first save.
#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    let path = settings_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Saves the settings: written next to the file, then renamed over it, so a
/// crash or full disk never leaves half a file.
#[tauri::command]
fn save_settings(app: AppHandle, content: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("invalid settings: {e}"))?;
    let path = settings_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(windows))]
    platform::use_login_shell_path();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(platform::mac_menu);
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(WatchState::default())
        .invoke_handler(tauri::generate_handler![
            run_git,
            read_file,
            write_file,
            initial_repo,
            watch_repo,
            unwatch_repo,
            find_child_repos,
            file_times,
            temp_index_path,
            remove_temp_index,
            is_file,
            launch_script,
            read_package_json,
            migrate_data_dir,
            paths_exist,
            copy_as_file,
            git_version,
            open_git_download,
            open_token_page,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hunkpad");
}
