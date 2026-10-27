//! The Mac is about to sleep (BLG-277): give the daemon a moment to mail what friends haven't
//! taken yet, so a closed lid doesn't strand it in the outbox until both Macs are on together.
//!
//! IOKit's system power notifications (not NSWorkspace's): a "will sleep" waits for our answer
//! (up to 30 s), so the network is still up while the daemon mails. We signal the daemon
//! (SIGUSR2, src/daemon/main.ts), wait for it to write `slept.at` (at most `WAIT`), then let the
//! Mac sleep. Idle sleep we never hold up any longer than that; asking "may it sleep?" we always allow.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime};

use crate::daemon;

type IoConnect = u32;
type IoObject = u32;
type NotificationPort = *mut c_void;
type RunLoop = *mut c_void;
type RunLoopSource = *mut c_void;
type CfString = *const c_void;
type Callback = extern "C" fn(refcon: *mut c_void, service: IoObject, message: u32, argument: *mut c_void);

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IORegisterForSystemPower(refcon: *mut c_void, port: *mut NotificationPort, callback: Callback, notifier: *mut IoObject) -> IoConnect;
    fn IONotificationPortGetRunLoopSource(port: NotificationPort) -> RunLoopSource;
    fn IOAllowPowerChange(kernel_port: IoConnect, notification_id: isize) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRunLoopGetCurrent() -> RunLoop;
    fn CFRunLoopAddSource(run_loop: RunLoop, source: RunLoopSource, mode: CfString);
    fn CFRunLoopRun();
    static kCFRunLoopDefaultMode: CfString;
}

const CAN_SYSTEM_SLEEP: u32 = 0xE000_0270;
const SYSTEM_WILL_SLEEP: u32 = 0xE000_0280;

/// Longest we hold the Mac awake for the daemon (its own limit is 4 s).
const WAIT: Duration = Duration::from_secs(5);

static ROOT: AtomicU32 = AtomicU32::new(0);

/// Whether the daemon wrote `slept.at` after `since`.
fn daemon_done(since: SystemTime) -> bool {
    std::fs::metadata(daemon::beluga_home().join("slept.at"))
        .and_then(|m| m.modified())
        .map(|at| at >= since)
        .unwrap_or(false)
}

/// Tell the daemon, and wait (a little) for it to have mailed its outboxes.
fn before_sleep() {
    let Some(pid) = daemon::running_pid() else { return };
    let asked = SystemTime::now() - Duration::from_millis(50);
    if !daemon::signal(pid, libc::SIGUSR2) {
        return;
    }
    let start = Instant::now();
    while start.elapsed() < WAIT && !daemon_done(asked) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

extern "C" fn on_power(_refcon: *mut c_void, _service: IoObject, message: u32, argument: *mut c_void) {
    let root = ROOT.load(Ordering::SeqCst);
    match message {
        CAN_SYSTEM_SLEEP => {
            // SAFETY: the root port IORegisterForSystemPower gave us, and the id it passed in.
            unsafe { IOAllowPowerChange(root, argument as isize) };
        }
        SYSTEM_WILL_SLEEP => {
            before_sleep();
            // SAFETY: as above; must be answered or the Mac waits 30 s before sleeping anyway.
            unsafe { IOAllowPowerChange(root, argument as isize) };
        }
        _ => {}
    }
}

/// Listen for sleep on a thread of its own (its run loop delivers IOKit's notifications).
pub fn watch() {
    let _ = std::thread::Builder::new().name("beluga-power".into()).spawn(|| {
        let mut port: NotificationPort = std::ptr::null_mut();
        let mut notifier: IoObject = 0;
        // SAFETY: plain IOKit / CoreFoundation calls with out-pointers to locals; the port and
        // its source live as long as this thread's run loop (the app's lifetime).
        unsafe {
            let root = IORegisterForSystemPower(std::ptr::null_mut(), &mut port, on_power, &mut notifier);
            if root == 0 || port.is_null() {
                return;
            }
            ROOT.store(root, Ordering::SeqCst);
            CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopDefaultMode);
            CFRunLoopRun();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_for_sleep_notifications() {
        let mut port: NotificationPort = std::ptr::null_mut();
        let mut notifier: IoObject = 0;
        // SAFETY: as in watch(); the test process ends without a run loop, nothing is delivered.
        let root = unsafe { IORegisterForSystemPower(std::ptr::null_mut(), &mut port, on_power, &mut notifier) };
        assert_ne!(root, 0);
        assert!(!port.is_null());
    }

    #[test]
    fn waits_only_for_a_marker_written_after_asking() {
        let dir = std::env::temp_dir().join(format!("beluga-power-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("BELUGA_HOME", &dir);
        let asked = SystemTime::now() - Duration::from_millis(50);
        assert!(!daemon_done(asked));
        std::fs::write(dir.join("slept.at"), "1\n").unwrap();
        assert!(daemon_done(asked));
        assert!(!daemon_done(SystemTime::now() + Duration::from_secs(60)));
    }
}
