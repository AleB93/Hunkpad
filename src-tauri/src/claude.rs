//! Runs the user's own Claude Code CLI (`claude -p`) for the optional Claude
//! features. Hunkpad keeps no API key: the CLI uses its own login. Claude is
//! given no tools, so it only reads what is sent on stdin and answers; every
//! change it suggests is applied by the frontend, through the usual Git flow.

use std::{
    collections::HashMap,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use crate::{drain, hidden, lock, GitOutput};

/// Error text the frontend recognises as "the claude CLI is not installed".
const CLAUDE_NOT_FOUND: &str = "CLAUDE_NOT_FOUND";

/// Longest a request may run before it is stopped.
const TIME_LIMIT: Duration = Duration::from_secs(10 * 60);

/// Cancel flags of the requests still running, by the frontend's request id.
static RUNNING: Mutex<Option<HashMap<u32, Arc<AtomicBool>>>> = Mutex::new(None);

/// `claude` from PATH, else where its installers put it. On macOS and Linux
/// the login shell's PATH is already in use (platform::use_login_shell_path).
fn find_claude() -> Option<PathBuf> {
    let works = |exe: &Path| {
        hidden(Command::new(exe).arg("--version"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    if works(Path::new("claude")) {
        return Some(PathBuf::from("claude"));
    }
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(&home).join(r".local\bin\claude.exe"));
            candidates.push(PathBuf::from(&home).join(r".claude\local\claude.exe"));
        }
        if let Ok(dir) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(dir).join(r"npm\claude.cmd"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(&home).join(".local/bin/claude"));
            candidates.push(PathBuf::from(&home).join(".claude/local/claude"));
        }
        candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
        candidates.push(PathBuf::from("/usr/local/bin/claude"));
    }
    candidates.into_iter().find(|c| c.is_file() && works(c))
}

/// The claude CLI's version ("2.1.296 (Claude Code)"), or None if it is not installed.
#[tauri::command]
pub async fn claude_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = find_claude()?;
        let out = hidden(Command::new(exe).arg("--version")).stdin(Stdio::null()).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Runs `claude <args>` in `cwd` with `stdin` as the prompt. `id` names the
/// request so `cancel_claude` can stop it. A non-zero exit is returned, not raised.
#[tauri::command]
pub async fn run_claude(cwd: String, args: Vec<String>, stdin: String, id: u32) -> Result<GitOutput, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&RUNNING).get_or_insert_with(HashMap::new).insert(id, cancel.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let exe = find_claude().ok_or_else(|| CLAUDE_NOT_FOUND.to_string())?;
        let mut cmd = Command::new(exe);
        // When Hunkpad was started from inside a Claude Code session, its variables
        // (e.g. "the host refreshes the login") would make this CLI misbehave.
        for (key, _) in std::env::vars_os() {
            let k = key.to_string_lossy();
            if k == "CLAUDECODE" || k.starts_with("CLAUDE_CODE_") || k.starts_with("CLAUDE_AGENT_SDK_") || k == "CLAUDE_PID" {
                cmd.env_remove(&key);
            }
        }
        let mut child = hidden(cmd.current_dir(&cwd).args(&args))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to run claude: {e}"))?;
        let mut pipe = child.stdin.take().expect("stdin is piped");
        // Written from another thread so a large stdout cannot deadlock us; dropping the pipe ends the input.
        std::thread::spawn(move || {
            let _ = pipe.write_all(stdin.as_bytes());
        });
        let out_pipe = child.stdout.take().expect("stdout is piped");
        let err_pipe = child.stderr.take().expect("stderr is piped");
        let out_thread = std::thread::spawn(move || drain(out_pipe, None));
        let err_thread = std::thread::spawn(move || drain(err_pipe, None));
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if cancel.load(Ordering::Relaxed) || started.elapsed() > TIME_LIMIT {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if cancel.load(Ordering::Relaxed) {
                    "CLAUDE_CANCELLED".to_string()
                } else {
                    "Claude did not answer within 10 minutes".to_string()
                });
            }
            std::thread::sleep(Duration::from_millis(50));
        };
        let stdout = out_thread.join().unwrap_or_default();
        let stderr = err_thread.join().unwrap_or_default();
        Ok(GitOutput {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(map) = lock(&RUNNING).as_mut() {
        map.remove(&id);
    }
    result
}

/// Opens a terminal window running `claude auth login`: signing in can need a
/// browser and a code typed back, which only the CLI's own prompt can do.
#[tauri::command]
pub fn claude_sign_in(cwd: String) -> Result<(), String> {
    let exe = find_claude().ok_or_else(|| CLAUDE_NOT_FOUND.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        Command::new(exe)
            .args(["auth", "login"])
            .current_dir(&cwd)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("could not open a terminal: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let exe = crate::platform::quote(&exe.to_string_lossy());
        crate::platform::launch_in_terminal(&cwd, &format!("{exe} auth login"))
    }
}

/// Stops a running request (it then fails with "CLAUDE_CANCELLED").
#[tauri::command]
pub fn cancel_claude(id: u32) {
    if let Some(flag) = lock(&RUNNING).as_ref().and_then(|m| m.get(&id)) {
        flag.store(true, Ordering::Relaxed);
    }
}
