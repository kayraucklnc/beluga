//! Keeping Beluga's daemon running: find the one that runs (`beluga daemon` run by hand, say),
//! else start the bundled one, and tell the web view where it is.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// How long Beluga gets to start before we give up.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a daemon gets to quit on its own before it's forced.
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// How long your shell gets to say what your PATH is.
const SHELL_TIMEOUT: Duration = Duration::from_secs(4);
const PATH_MARK: &str = "__BELUGA_PATH__";

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
    /// The Beluga version it runs (missing only in daemon.json files from very old versions).
    #[serde(default)]
    version: Option<String>,
    /// Started to stay up for the Mac app (`--keep-alive`), not run by hand.
    #[serde(default, rename = "keepAlive")]
    keep_alive: bool,
}

impl From<Info> for Endpoint {
    fn from(info: Info) -> Self {
        Endpoint {
            url: format!("ws://127.0.0.1:{}", info.port),
            token: info.token,
        }
    }
}

/// Lock a mutex even if another thread panicked while holding it (the data is still fine here).
pub fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Where Beluga keeps its things, as the core decides it (src/core/home.ts): $BELUGA_HOME (or the
/// $KLAUD_HOME / $KLAUDE_HOME of before the rename), else ~/.beluga. Until the core has moved an
/// older ~/.klaud there (it does on its first start), that one is read.
pub fn beluga_home() -> PathBuf {
    let var = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty());
    let set = var("BELUGA_HOME")
        .or_else(|| var("KLAUD_HOME"))
        .or_else(|| var("KLAUDE_HOME"));
    home_in(
        set.map(PathBuf::from),
        &dirs::home_dir().unwrap_or_default(),
    )
}

fn home_in(set: Option<PathBuf>, user_home: &std::path::Path) -> PathBuf {
    if let Some(dir) = set {
        return dir;
    }
    let home = user_home.join(".beluga");
    if home.exists() {
        return home;
    }
    [".klaud", ".klaude"]
        .iter()
        .map(|name| user_home.join(name))
        .find(|old| old.exists())
        .unwrap_or(home)
}

/// Send a signal to a process (0 only checks that it's there and ours).
pub fn signal(pid: u32, sig: i32) -> bool {
    // Never 0 (our whole process group) or 1 (the system's first process).
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    if pid <= 1 {
        return false;
    }
    // SAFETY: kill(2) takes plain integers and has no memory effects; a bad pid just fails.
    unsafe { libc::kill(pid, sig) == 0 }
}

fn alive(pid: u32) -> bool {
    signal(pid, 0)
}

/// Whether something answers on Beluga's port (a leftover pid could belong to anything).
fn listening(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn read_info() -> Option<Info> {
    let text = std::fs::read_to_string(beluga_home().join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The daemon that's really up: its process is there and it answers on its port.
fn up() -> Option<Info> {
    read_info().filter(|info| alive(info.pid) && listening(info.port))
}

/// The running daemon's process id (to look at its terminals), if one runs.
pub fn running_pid() -> Option<u32> {
    up().map(|info| info.pid)
}

/// The Beluga version bundled in this app (its package.json), `None` in development.
fn bundled_version(app: &AppHandle) -> Option<String> {
    let resources = app.path().resource_dir().ok()?;
    let text = std::fs::read_to_string(resources.join("daemon").join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("version")?.as_str().map(str::to_owned)
}

/// Whether a running daemon is an older (or other) Beluga this app should replace with its
/// own: only a kept-alive one (a Mac app started it, maybe the version before an update),
/// never one started by hand.
fn outdated(running: Option<&str>, keep_alive: bool, bundled: Option<&str>) -> bool {
    keep_alive && matches!((running, bundled), (Some(r), Some(b)) if r != b)
}

/// If the daemon this app started has quit, let go of it (so it doesn't linger) and say how.
fn reap(app: &AppHandle) -> Option<ExitStatus> {
    let state = app.try_state::<AppState>()?;
    let mut slot = locked(&state.child);
    let status = slot.as_mut()?.try_wait().ok().flatten()?;
    *slot = None;
    Some(status)
}

fn running(app: &AppHandle) -> Option<Info> {
    reap(app);
    up()
}

/// Apps opened from Finder get a bare PATH; Beluga needs yours (git, gh, claude, node tools).
async fn login_path() -> String {
    static PATH: OnceLock<String> = OnceLock::new();
    if let Some(path) = PATH.get() {
        return path.clone();
    }
    let found = tauri::async_runtime::spawn_blocking(shell_path)
        .await
        .ok()
        .flatten();
    PATH.get_or_init(|| found.unwrap_or_else(fallback_path))
        .clone()
}

/// Ask your login shell for its PATH, giving up (and stopping it) if it takes too long.
fn shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!("printf '{PATH_MARK}%s{PATH_MARK}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 {
                break;
            }
            seen.extend_from_slice(&chunk[..n]);
            if parse_path(&String::from_utf8_lossy(&seen)).is_some() {
                break;
            }
        }
        let _ = tx.send(seen);
    });
    let seen = rx.recv_timeout(SHELL_TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    parse_path(&String::from_utf8_lossy(&seen?))
}

/// The PATH between the markers (your shell's startup files may print other things too).
fn parse_path(text: &str) -> Option<String> {
    let rest = &text[text.find(PATH_MARK)? + PATH_MARK.len()..];
    let path = rest[..rest.find(PATH_MARK)?].trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// When the shell can't say: the PATH we have, plus where Homebrew puts things.
fn fallback_path() -> String {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    std::env::join_paths(dirs)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin".into())
}

fn log_file() -> Option<std::fs::File> {
    let dir = beluga_home().join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("daemon.log"))
        .ok()
}

/// The end of the daemon's log written since `from` (for saying why Beluga didn't start).
fn log_tail(from: u64) -> String {
    let read = || -> Option<String> {
        let mut file = std::fs::File::open(beluga_home().join("logs").join("daemon.log")).ok()?;
        let len = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(from.min(len).max(len.saturating_sub(2000))))
            .ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).trim().to_string())
    };
    match read() {
        Some(tail) if !tail.is_empty() => format!("\n{tail}"),
        _ => String::new(),
    }
}

/// The command that runs Beluga's daemon, and whether its pid is the daemon's own pid (it isn't
/// when a launcher like `npx` sits in between).
fn base_command(app: &AppHandle) -> Result<(Command, bool), String> {
    if let Some((node, script)) = bundled(app) {
        let mut c = Command::new(node);
        c.arg(script);
        return Ok((c, true));
    }
    dev_command().map(|c| (c, false))
}

/// Development: run Beluga from the repository with tsx.
#[cfg(debug_assertions)]
fn dev_command() -> Result<Command, String> {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut c = Command::new("npx");
    c.current_dir(&repo).args(["tsx", "src/cli.ts"]);
    c.env("BELUGA_ALLOW_ORIGINS", "http://localhost:1420");
    Ok(c)
}

#[cfg(not(debug_assertions))]
fn dev_command() -> Result<Command, String> {
    Err("Beluga's engine is missing from this app. Please reinstall Beluga.".into())
}

/// The Node binary and Beluga's bundled entry inside the app, when they're there.
fn bundled(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let resources = app.path().resource_dir().ok()?;
    let script = resources.join("daemon").join("dist").join("cli.js");
    let node = std::env::current_exe().ok()?.parent()?.join("node");
    (script.exists() && node.exists()).then_some((node, script))
}

/// Start the daemon and keep hold of it; wait until it's ready.
async fn start(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    let (mut cmd, own_pid) = base_command(app)?;
    cmd.arg("daemon").arg("--keep-alive").args(args);
    cmd.env("PATH", login_path().await);
    cmd.stdin(Stdio::null());
    let log = log_file();
    let log_from = log
        .as_ref()
        .and_then(|f| f.metadata().ok())
        .map_or(0, |m| m.len());
    if let Some(f) = log {
        if let Ok(clone) = f.try_clone() {
            cmd.stdout(Stdio::from(clone));
        }
        cmd.stderr(Stdio::from(f));
    }
    let began = SystemTime::now();
    let child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start Beluga: {e}"))?;
    let pid = child.id();
    if let Some(state) = app.try_state::<AppState>() {
        *locked(&state.child) = Some(child);
    }
    // Only the daemon we just started counts: an old daemon.json must not satisfy the wait.
    let ours = |info: &Info| {
        if own_pid {
            info.pid == pid
        } else {
            std::fs::metadata(beluga_home().join("daemon.json"))
                .and_then(|m| m.modified())
                .is_ok_and(|t| t >= began)
        }
    };
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(status) = reap(app) {
            // Another Beluga may have won the start (only one daemon runs): use that one.
            if let Some(info) = up() {
                return Ok(info.into());
            }
            return Err(format!(
                "Beluga stopped while starting ({status}). See ~/.beluga/logs/daemon.log{}",
                log_tail(log_from)
            ));
        }
        if let Some(info) = up().filter(ours) {
            return Ok(info.into());
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let child = app
        .try_state::<AppState>()
        .and_then(|state| locked(&state.child).take());
    if let Some(child) = child {
        terminate_child(child).await;
    }
    Err("Beluga didn't start in time. See ~/.beluga/logs/daemon.log".into())
}

/// Ask a daemon we started to quit; force it if it doesn't.
async fn terminate_child(mut child: Child) -> bool {
    signal(child.id(), libc::SIGTERM);
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    child.kill().is_ok() && child.wait().is_ok()
}

/// Ask a daemon this app didn't start to quit; force it if it doesn't.
async fn terminate_pid(pid: u32) -> bool {
    if !signal(pid, libc::SIGTERM) {
        return !alive(pid);
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    signal(pid, libc::SIGKILL);
    for _ in 0..10 {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Stop whichever daemon runs, ours or another, and wait until it's gone.
async fn stop_running(app: &AppHandle) -> Result<(), String> {
    let child = app
        .try_state::<AppState>()
        .and_then(|state| locked(&state.child).take());
    if let Some(child) = child {
        terminate_child(child).await;
    }
    if let Some(info) = up() {
        if !terminate_pid(info.pid).await {
            return Err("Couldn't stop the Beluga that's running.".into());
        }
    }
    Ok(())
}

/// Make sure Beluga runs, and say where it listens.
pub async fn ensure(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    let state = app.state::<AppState>();
    let _one_at_a_time = state.lock.lock().await;
    if let Some(info) = running(app) {
        let bundled = bundled_version(app);
        if !outdated(info.version.as_deref(), info.keep_alive, bundled.as_deref()) {
            return Ok(info.into());
        }
        // After an update: the screens reconnect to the new one by themselves.
        eprintln!(
            "beluga: replacing Beluga {} with this app's {}",
            info.version.as_deref().unwrap_or("?"),
            bundled.as_deref().unwrap_or("?")
        );
        stop_running(app).await?;
    }
    start(app, args).await
}

/// Start Beluga again with these arguments (a link to a friend's room): the running one stops first.
pub async fn restart(app: &AppHandle, args: &[String]) -> Result<Endpoint, String> {
    check_join(args)?;
    let state = app.state::<AppState>();
    let _one_at_a_time = state.lock.lock().await;
    stop_running(app).await?;
    start(app, args).await
}

/// Only joining a friend's room is allowed: `join <invite link>`.
fn check_join(args: &[String]) -> Result<(), String> {
    const PREFIXES: [&str; 7] = [
        "beluga://",
        "klaud://",
        "https://",
        "http://",
        "wss://",
        "ws://",
        "klaude:",
    ];
    let [verb, invite] = args else {
        return Err("That isn't something Beluga can start with.".into());
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || "-._~:/?#=&%".contains(c);
    if verb != "join"
        || invite.len() > 2048
        || !PREFIXES.iter().any(|p| invite.starts_with(p))
        || !invite.chars().all(plain)
    {
        return Err("That doesn't look like a Beluga invite.".into());
    }
    Ok(())
}

/// Stop the daemon this app started (one started elsewhere is left alone).
pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(mut child) = locked(&state.child).take() else {
        return;
    };
    signal(child.id(), libc::SIGTERM);
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn accepts_the_join_flow() {
        let key = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1";
        for invite in [
            format!("klaud://{key}?relay=https%3A%2F%2Fcalm-river.trycloudflare.com#k3Jd-abc_123"),
            "https://calm-river.trycloudflare.com#k3Jd-abc_123".to_string(),
            "klaude:eyJ1cmwiOiJ3cyJ9".to_string(),
            format!("beluga://{key}?relay=https%3A%2F%2Fcalm-river.trycloudflare.com#k3Jd-abc_123"),
        ] {
            assert!(check_join(&args(&["join", &invite])).is_ok(), "{invite}");
        }
    }

    #[test]
    fn rejects_anything_else() {
        assert!(check_join(&args(&[])).is_err());
        assert!(check_join(&args(&["join"])).is_err());
        assert!(check_join(&args(&["daemon", "https://a.b#c"])).is_err());
        assert!(check_join(&args(&["join", "--home=/tmp"])).is_err());
        assert!(check_join(&args(&["join", "-x"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b#c", "--flag"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b#c d"])).is_err());
        assert!(check_join(&args(&["join", "https://a.b/;rm"])).is_err());
    }

    #[test]
    fn finds_the_path_between_the_markers() {
        let out = format!("welcome!\n{PATH_MARK}/usr/bin:/bin{PATH_MARK}");
        assert_eq!(parse_path(&out).as_deref(), Some("/usr/bin:/bin"));
        assert_eq!(parse_path("nothing here"), None);
        assert_eq!(parse_path(&format!("{PATH_MARK}/usr/bin")), None);
    }

    #[test]
    fn replaces_only_a_kept_alive_daemon_of_another_version() {
        assert!(outdated(Some("0.4.0"), true, Some("0.5.0")));
        assert!(!outdated(Some("0.5.0"), true, Some("0.5.0")));
        // A daemon started by hand is left alone, whatever its version.
        assert!(!outdated(Some("0.4.0"), false, Some("0.5.0")));
        // Development (nothing bundled), or a daemon that doesn't say.
        assert!(!outdated(Some("0.4.0"), true, None));
        assert!(!outdated(None, true, Some("0.5.0")));
    }

    #[test]
    fn reads_what_the_daemon_wrote() {
        let info: Info = serde_json::from_str(
            r#"{"pid":42,"port":5000,"token":"t","version":"0.4.0","ipc":3,"room":"r","keepAlive":true}"#,
        )
        .unwrap();
        assert_eq!(info.version.as_deref(), Some("0.4.0"));
        assert!(info.keep_alive);
        let old: Info = serde_json::from_str(r#"{"pid":42,"port":5000,"token":"t"}"#).unwrap();
        assert!(old.version.is_none() && !old.keep_alive);
    }

    #[test]
    fn never_signals_process_zero_or_one() {
        assert!(!signal(0, 0));
        assert!(!signal(1, 0));
    }

    #[test]
    fn home_follows_the_core() {
        let tmp = std::env::temp_dir().join(format!("beluga-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // A fresh Mac: ~/.beluga, even before it exists.
        assert_eq!(home_in(None, &tmp), tmp.join(".beluga"));
        // Before the core's first start moved it: the old ~/.klaud.
        std::fs::create_dir(tmp.join(".klaud")).unwrap();
        assert_eq!(home_in(None, &tmp), tmp.join(".klaud"));
        // Once ~/.beluga is there, always that.
        std::fs::create_dir(tmp.join(".beluga")).unwrap();
        assert_eq!(home_in(None, &tmp), tmp.join(".beluga"));
        // A home set in the environment wins.
        assert_eq!(
            home_in(Some(PathBuf::from("/x")), &tmp),
            PathBuf::from("/x")
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
