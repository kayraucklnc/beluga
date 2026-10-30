//! Beluga's desktop widgets (BLG-309). The daemon keeps the boards' tiles in
//! `~/.beluga/widgets/tiles.json`; the widget extension (packages/mac/widgets, in
//! Contents/PlugIns) reads it. Only the containing app may ask macOS to redraw its widgets, so this
//! watches the file and asks: at once while Beluga is in front (that doesn't count against the
//! widgets' budget), otherwise at most every five minutes. The widget also looks again every
//! half hour by itself, which covers Beluga being quit.
//!
//! An update swaps the extension's files but not a copy of it macOS already has running: that one
//! keeps answering with the old build number, and macOS throws away everything it draws ("Bundle
//! version did not match"), so the widgets sat grey until a restart (BLG-423). On start, Beluga
//! stops any copy older than its files and asks for a redraw.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use tauri::{AppHandle, Manager, Runtime};

/// How often the file is looked at, and how often widgets are redrawn while Beluga is behind.
const LOOK: Duration = Duration::from_secs(2);
const BEHIND: Duration = Duration::from_secs(5 * 60);

#[cfg(all(target_os = "macos", widgets_shim))]
extern "C" {
    fn beluga_widgets_reload();
}

/// Ask macOS to redraw Beluga's widgets (nothing when the app was built without the shim).
fn reload() {
    #[cfg(all(target_os = "macos", widgets_shim))]
    // SAFETY: a C function with no arguments that only calls WidgetCenter.
    unsafe {
        beluga_widgets_reload();
    }
}

fn tiles() -> PathBuf {
    crate::daemon::beluga_home().join("widgets").join("tiles.json")
}

/// The extension's executable inside this app (Contents/PlugIns), if it has one.
fn extension() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    let bin = contents.join("PlugIns/BelugaWidgets.appex/Contents/MacOS/BelugaWidgets");
    bin.exists().then_some(bin)
}

/// Seconds since a process started, from ps's `etime` (`[[dd-]hh:]mm:ss`).
pub fn elapsed(etime: &str) -> Option<u64> {
    let (days, rest) = match etime.trim().split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, etime.trim()),
    };
    let parts = rest.split(':').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
    let (h, m, s) = match parts[..] {
        [m, s] => (0, m, s),
        [h, m, s] => (h, m, s),
        _ => return None,
    };
    Some(((days * 24 + h) * 60 + m) * 60 + s)
}

/// Stop running copies of the extension that started before its files were last replaced.
fn stop_stale() -> bool {
    let Some(bin) = extension() else { return false };
    let Some(built) = changed_at(&bin) else { return false };
    let Ok(out) = std::process::Command::new("/usr/bin/pgrep").arg("-f").arg(&bin).output() else { return false };
    let mut stopped = false;
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        let Ok(ps) = std::process::Command::new("/bin/ps").args(["-o", "etime=", "-p", pid]).output() else { continue };
        let Some(secs) = elapsed(&String::from_utf8_lossy(&ps.stdout)) else { continue };
        let started = SystemTime::now() - Duration::from_secs(secs);
        if started + Duration::from_secs(2) < built {
            stopped |= std::process::Command::new("/bin/kill").arg(pid).status().is_ok_and(|s| s.success());
        }
    }
    stopped
}

fn changed_at(file: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(file).and_then(|m| m.modified()).ok()
}

/// Whether to redraw now: something changed, and Beluga is in front or it's been long enough.
pub fn due(changed: bool, front: bool, since_last: Option<Duration>) -> bool {
    changed && (front || since_last.map_or(true, |d| d >= BEHIND))
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        if stop_stale() {
            // macOS starts the new copy when asked to redraw.
            reload();
        }
        let file = tiles();
        let mut seen = changed_at(&file);
        let mut pending = false;
        let mut last: Option<Instant> = None;
        loop {
            std::thread::sleep(LOOK);
            let now = changed_at(&file);
            if now != seen {
                seen = now;
                pending = true;
            }
            let front = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            if due(pending, front, last.map(|t| t.elapsed())) {
                reload();
                pending = false;
                last = Some(Instant::now());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redraws_at_once_in_front_and_sparingly_behind() {
        assert!(!due(false, true, None));
        assert!(due(true, true, Some(Duration::from_secs(1))));
        assert!(due(true, false, None));
        assert!(!due(true, false, Some(Duration::from_secs(60))));
        assert!(due(true, false, Some(BEHIND)));
    }

    #[test]
    fn reads_how_long_a_process_has_run() {
        assert_eq!(elapsed("00:07"), Some(7));
        assert_eq!(elapsed(" 12:34\n"), Some(12 * 60 + 34));
        assert_eq!(elapsed("01:02:03"), Some(3723));
        assert_eq!(elapsed("1-00:00:05"), Some(86405));
        assert_eq!(elapsed(""), None);
        assert_eq!(elapsed("x:1"), None);
    }
}
