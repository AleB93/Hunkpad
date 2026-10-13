//! What differs between Windows, macOS and Linux: putting a file on the
//! clipboard, running a script in a terminal window, opening a web page, the
//! PATH of apps started outside a terminal, and the macOS menu bar.

use std::path::Path;
#[cfg(not(windows))]
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// Opens `url` in the default browser.
pub fn open_url(url: &str) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(url);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not open {url}: {e}"))
}

/// Git's download page for this platform.
pub const GIT_DOWNLOAD_URL: &str = if cfg!(windows) {
    "https://git-scm.com/download/win"
} else if cfg!(target_os = "macos") {
    "https://git-scm.com/download/mac"
} else {
    "https://git-scm.com/download/linux"
};

// ---- clipboard ----------------------------------------------------------------

/// Puts `path` on the clipboard as a file, like copying it in Explorer or Finder,
/// so pasting into a chat attaches it. Not on Linux, where it depends on the
/// desktop; the frontend copies text there.
pub fn copy_file_to_clipboard(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use clipboard_win::{options::DoClear, raw, Clipboard};
        use std::time::Duration;
        // Open the clipboard (retrying if another app holds it), empty it, and put
        // just this file on it: otherwise older copied text would stay alongside
        // and a chat could paste that instead of the file.
        // Other apps (clipboard history, Teams…) briefly lock the clipboard right
        // after it changes: retry with short pauses, ~1 s in total.
        let mut opened = Clipboard::new();
        for _ in 0..40 {
            if opened.is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
            opened = Clipboard::new();
        }
        let _clip = opened.map_err(|e| format!("could not open the clipboard (another app is using it): {e}"))?;
        let path = path.to_string_lossy();
        raw::set_file_list_with(&[path.as_ref()], DoClear)
            .map_err(|e| format!("could not put the file on the clipboard: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::{NSArray, NSString, NSURL};
        // A file URL, as Finder's Copy writes it. clearContents first, so older
        // copied text does not stay alongside (a chat could paste that instead).
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let item = ProtocolObject::<dyn NSPasteboardWriting>::from_retained(url);
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if board.writeObjects(&NSArray::from_retained_slice(&[item])) {
            Ok(())
        } else {
            Err("could not put the file on the clipboard".into())
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = path;
        Err("copying as a file is not supported on Linux: use Copy for LLM as text".into())
    }
}

// ---- running a user script in a terminal ------------------------------------------

/// Starts `script` in a new terminal window, in `cwd`, through a small launcher
/// that keeps the window open until Enter so the output can be read. The
/// interpreter follows the extension; other files must be executable.
#[cfg(not(windows))]
pub fn launch_in_terminal(cwd: &str, script: &Path, ext: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let quote = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
    let file = quote(&script.to_string_lossy());
    let run = match ext {
        "sh" | "bash" | "command" => format!("bash {file}"),
        "zsh" => format!("zsh {file}"),
        "py" => format!("python3 {file}"),
        "js" | "mjs" => format!("node {file}"),
        "ps1" => format!("pwsh -NoProfile -File {file}"),
        _ => {
            let executable = std::fs::metadata(script).is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
            if !executable {
                return Err(format!(
                    "{} is not executable: run chmod +x on it, or use a .sh, .py or .js file",
                    script.display()
                ));
            }
            file
        }
    };

    let dir = std::env::temp_dir().join("hunkpad-scripts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // .command: on macOS, `open` runs it in the user's default terminal (Terminal.app).
    let launcher = dir.join(format!("run-{nanos}.command"));
    let body = format!(
        "#!/bin/bash\n\
         rm -f -- \"$0\"\n\
         cd {} || exit 1\n\
         {run}\n\
         code=$?\n\
         echo\n\
         read -r -p \"[exit code $code] Press Enter to close. \" _\n",
        quote(cwd)
    );
    std::fs::write(&launcher, body).map_err(|e| format!("{}: {e}", launcher.display()))?;
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("{}: {e}", launcher.display()))?;

    let started = open_terminal(&launcher);
    if started.is_err() {
        let _ = std::fs::remove_file(&launcher);
    }
    started
}

#[cfg(target_os = "macos")]
fn open_terminal(launcher: &Path) -> Result<(), String> {
    Command::new("open")
        .arg(launcher)
        .status()
        .map_err(|e| format!("could not open Terminal: {e}"))
        .and_then(|s| if s.success() { Ok(()) } else { Err("could not open Terminal".into()) })
}

/// The first terminal found: $TERMINAL, then the common ones. Each wants the
/// command to run in its own way.
#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(launcher: &Path) -> Result<(), String> {
    let mut candidates: Vec<(String, &[&str])> = Vec::new();
    if let Ok(t) = std::env::var("TERMINAL") {
        candidates.push((t, &["-e"]));
    }
    const KNOWN: [(&str, &[&str]); 12] = [
        ("x-terminal-emulator", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("kgx", &["--"]),
        ("ptyxis", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-x"]),
        ("tilix", &["-e"]),
        ("alacritty", &["-e"]),
        ("kitty", &[]),
        ("wezterm", &["start", "--"]),
        ("foot", &[]),
        ("xterm", &["-e"]),
    ];
    candidates.extend(KNOWN.iter().map(|(t, a)| (t.to_string(), *a)));
    for (term, args) in candidates {
        match Command::new(&term).args(args).arg(launcher).stdin(Stdio::null()).spawn() {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("could not start {term}: {e}")),
        }
    }
    Err("no terminal found: set the TERMINAL environment variable (e.g. TERMINAL=gnome-terminal)".into())
}

// ---- PATH ---------------------------------------------------------------------

/// Apps started from the Finder, the Dock or a desktop launcher get a minimal
/// PATH, without what the shell profile adds (Homebrew, nvm, ~/.local/bin…).
/// Git hooks and credential helpers often need those, so the login shell's PATH
/// goes in front. Called once at startup, before any thread is started.
#[cfg(not(windows))]
pub fn use_login_shell_path() {
    const MARK: &str = "__HUNKPAD_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // `;` and `echo` work the same in sh, bash, zsh and fish.
    let script = format!("echo {MARK}; /usr/bin/printenv PATH; echo {MARK}");
    let Ok(mut child) = Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    // A slow or broken shell profile must not hold up the start.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
    let mut out = String::new();
    if child.stdout.take().map(|mut s| s.read_to_string(&mut out)).is_none() {
        return;
    }
    let Some(login) = out.split(MARK).nth(1).map(str::trim).filter(|p| !p.is_empty()) else {
        return;
    };
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = login.split(':').collect();
    for p in current.split(':') {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

// ---- macOS menu bar -------------------------------------------------------------

/// Tauri's default macOS menu, without File → Close Window: its ⌘W would close
/// the whole app instead of reaching the page, where ⌘W closes a repository tab.
#[cfg(target_os = "macos")]
pub fn mac_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem as Item, Submenu};
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &Item::about(app, None, Some(about))?,
                    &Item::separator(app)?,
                    &Item::services(app, None)?,
                    &Item::separator(app)?,
                    &Item::hide(app, None)?,
                    &Item::hide_others(app, None)?,
                    &Item::show_all(app, None)?,
                    &Item::separator(app)?,
                    &Item::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &Item::undo(app, None)?,
                    &Item::redo(app, None)?,
                    &Item::separator(app)?,
                    &Item::cut(app, None)?,
                    &Item::copy(app, None)?,
                    &Item::paste(app, None)?,
                    &Item::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&Item::fullscreen(app, None)?])?,
            &Submenu::with_items(
                app,
                "Window",
                true,
                &[&Item::minimize(app, None)?, &Item::maximize(app, None)?],
            )?,
        ],
    )
}
