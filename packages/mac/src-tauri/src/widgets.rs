//! Beluga's desktop widgets (BLG-309). The daemon keeps the boards' tiles in
//! `~/.beluga/widgets/tiles.json`; the widget extension (packages/mac/widgets, in
//! Contents/PlugIns) reads it. Only the containing app may ask macOS to redraw its widgets, so this
//! watches the file and asks: at once while Beluga is in front (that doesn't count against the
//! widgets' budget), otherwise at most every five minutes. The widget also looks again every
//! half hour by itself, which covers Beluga being quit.

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
}
