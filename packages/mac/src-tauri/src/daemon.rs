//! Keeping klaud's daemon running: find the one that runs (the terminal app may have started
//! it), else start the bundled one, and tell the web view where it is.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

use crate::AppState;

#[derive(Serialize, Clone)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
}

#[derive(Deserialize)]
struct Info {
    pid: u32,
    port: u16,
    token: String,
}

fn klaud_home() -> PathBuf {
    std::env::var_os("KLAUD_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".klaud"))
}

/// Send a signal to a process (0 only checks that it's there and ours).
fn signal(pid: u32, sig: i32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: kill(2) takes plain integers and has no memory effects; a bad pid just fails.
    unsafe { libc::kill(pid, sig) == 0 }
}

fn alive(pid: u32) -> bool {
    signal(pid, 0)
}

fn running() -> Option<Info> {
    let text = std::fs::read_to_string(klaud_home().join("daemon.json")).ok()?;
    let info: Info = serde_json::from_str(&text).ok()?;
    alive(info.pid).then_some(info)
}

/// Apps opened from Finder get a bare PATH; klaud needs yours (git, gh, claude, node tools).
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let path = String::from_utf8(out.stdout).ok()?;
    (!path.trim().is_empty()).then(|| path.trim().to_string())
}

fn log_file() -> Option<std::fs::File> {
    let dir = klaud_home().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("daemon.log"))
        .ok()
}

/// Start the daemon: the bundled Node and klaud in a release build; this repo's sources while developing.
fn spawn(app: &AppHandle, args: &[String]) -> Result<u32, String> {
    let mut cmd = if let Some((node, script)) = bundled(app) {
        let mut c = Command::new(node);
        c.arg(script);
        c
    } else {
        // Development: run klaud from the repository with tsx.
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let mut c = Command::new("npx");
        c.current_dir(&repo).args(["tsx", "src/cli.tsx"]);
        c.env("KLAUD_ALLOW_ORIGINS", "http://localhost:1420");
        c
    };
    cmd.arg("daemon").arg("--keep-alive").args(args);
    if let Some(path) = login_path() {
        cmd.env("PATH", path);
    }
    let log = log_file();
    cmd.stdin(Stdio::null());
    if let Some(f) = log {
        if let Ok(clone) = f.try_clone() {
            cmd.stdout(Stdio::from(clone));
        }
        cmd.stderr(Stdio::from(f));
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start klaud: {e}"))?;
    Ok(child.id())
}

/// The Node binary and klaud's bundled entry inside the app, when they're there.
fn bundled(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resources = app.path().resource_dir().ok()?;
    let script = resources.join("daemon").join("dist").join("cli.js");
    let node = std::env::current_exe().ok()?.parent()?.join("node");
    (script.exists() && node.exists()).then_some((node, script))
}

/// Make sure klaud runs, and say where it listens.
pub async fn ensure(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    if let Some(info) = running() {
        return Ok(Endpoint {
            url: format!("ws://127.0.0.1:{}", info.port),
            token: info.token,
        });
    }
    let pid = spawn(app, args)?;
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut started) = state.started.lock() {
            *started = Some(pid);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(info) = running() {
            return Ok(Endpoint {
                url: format!("ws://127.0.0.1:{}", info.port),
                token: info.token,
            });
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(150)))
            .await
            .ok();
    }
    Err("klaud didn't start in time. See ~/.klaud/logs/daemon.log".into())
}

/// Stop the daemon this app started (one the terminal app started stops by itself).
pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(pid) = state.started.lock().ok().and_then(|mut s| s.take()) else {
        return;
    };
    if running().is_some_and(|info| info.pid == pid) {
        signal(pid, libc::SIGTERM);
    }
}
