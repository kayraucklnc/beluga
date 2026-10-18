//! When Klaud looks for a new version, and when it's fine to install one without asking.
//! Pure decisions (no clock, network or processes of their own), so they're tested below.

use serde::{Deserialize, Serialize};
use std::time::Duration;

const HOUR_MS: u64 = 3_600_000;
/// Opening Klaud (or waking the Mac) looks for an update when the last look is older than this.
pub const LAUNCH_AFTER_MS: u64 = 20 * HOUR_MS;
/// While Klaud stays open, it looks once a day.
pub const EVERY_MS: u64 = 24 * HOUR_MS;
/// After a failed look (offline, GitHub down), wait this long before trying again.
pub const RETRY_AFTER_MS: u64 = HOUR_MS;
/// "Update when idle" waits until you haven't touched the Mac for this long.
pub const IDLE_FOR_SECS: f64 = 600.0;
/// A wall-clock jump this much bigger than the time Klaud was running means the Mac slept.
const SLEEP_GAP: Duration = Duration::from_secs(120);

/// Why a look for updates is being considered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Occasion {
    /// Klaud just opened.
    Launch,
    /// The Mac just woke from sleep.
    Wake,
    /// The regular tick while Klaud runs.
    Running,
}

/// Whether to look for an update now. `last_ok`: when a look last succeeded; `last_try`: when
/// one was last attempted (successful or not). Times are milliseconds since the epoch.
pub fn check_due(
    now: u64,
    last_ok: Option<u64>,
    last_try: Option<u64>,
    occasion: Occasion,
) -> bool {
    if let Some(tried) = last_try {
        if tried <= now && now - tried < RETRY_AFTER_MS {
            return false;
        }
    }
    let Some(ok) = last_ok else { return true };
    // The clock went backwards (or was wrong before): don't wait for it to catch up.
    if ok > now {
        return true;
    }
    let age = now - ok;
    match occasion {
        Occasion::Launch | Occasion::Wake => age >= LAUNCH_AFTER_MS,
        Occasion::Running => age >= EVERY_MS,
    }
}

/// Whether the Mac slept between two ticks: the wall clock moved on much more than the
/// monotonic one (which stops while the Mac sleeps).
pub fn slept(wall: Duration, monotonic: Duration) -> bool {
    wall > monotonic + SLEEP_GAP
}

/// What the window says is going on in klaud (see `useUpdateActivity` in lib/updates.ts).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Activity {
    /// Claude runs working or queued in this klaud.
    pub claude: u32,
    /// Other people in your room (a restart drops them and changes the invite link).
    pub guests: u32,
    /// You're in a friend's room (a restart brings you back to your own).
    pub joined: bool,
}

/// What still stands in the way of installing quietly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Blocker {
    /// Claude is working (or the window can't say whether it is).
    Claude,
    /// A program runs in one of klaud's terminals (not just the shell's prompt).
    Terminal,
    /// Friends are in your room, or you're in theirs.
    Room,
    /// You've used the Mac in the last 10 minutes.
    You,
}

pub struct IdleInputs {
    /// Whether klaud's daemon runs (when it doesn't, nothing of it can be interrupted).
    pub daemon_up: bool,
    /// The window's last report; `None` when it isn't connected.
    pub activity: Option<Activity>,
    /// Terminals with a program in the foreground; `None` when that couldn't be found out.
    pub busy_terminals: Option<usize>,
    /// Seconds since the last keyboard/mouse input anywhere on the Mac, if the system says.
    pub idle_secs: Option<f64>,
    /// Seconds since Klaud's window lost focus (`None` while it has it): the fallback for idle.
    pub unfocused_secs: Option<f64>,
    /// How long you must have been away (IDLE_FOR_SECS).
    pub idle_for: f64,
}

/// Everything that still blocks a quiet install (empty: go ahead).
pub fn blockers(i: &IdleInputs) -> Vec<Blocker> {
    let mut out = Vec::new();
    if i.daemon_up {
        match i.activity {
            None => out.push(Blocker::Claude),
            Some(a) => {
                if a.claude > 0 {
                    out.push(Blocker::Claude);
                }
                if a.guests > 0 || a.joined {
                    out.push(Blocker::Room);
                }
            }
        }
        if i.busy_terminals != Some(0) {
            out.push(Blocker::Terminal);
        }
    }
    let away = match i.idle_secs {
        Some(secs) => secs >= i.idle_for,
        None => i.unfocused_secs.is_some_and(|s| s >= i.idle_for),
    };
    if !away {
        out.push(Blocker::You);
    }
    out
}

/// One line of `ps -A -o pid=,ppid=,pgid=,tpgid=`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: i64,
    /// The terminal's foreground process group (0 or -1: no terminal).
    pub tpgid: i64,
}

pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            Some(Proc {
                pid: f.next()?.parse().ok()?,
                ppid: f.next()?.parse().ok()?,
                pgid: f.next()?.parse().ok()?,
                tpgid: f.next()?.parse().ok()?,
            })
        })
        .collect()
}

/// klaud's terminals running a program: each terminal's shell is a child of the daemon with
/// its own terminal, and while something runs in it (a build, a dev server, vim) the
/// terminal's foreground group is that program's, not the shell's.
pub fn busy_terminals(procs: &[Proc], daemon_pid: u32) -> usize {
    procs
        .iter()
        .filter(|p| p.ppid == daemon_pid && p.tpgid > 0 && p.tpgid != p.pgid)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000;

    #[test]
    fn looks_on_launch_only_when_the_last_look_is_old() {
        assert!(check_due(NOW, None, None, Occasion::Launch));
        assert!(!check_due(
            NOW,
            Some(NOW - 19 * HOUR_MS),
            None,
            Occasion::Launch
        ));
        assert!(check_due(
            NOW,
            Some(NOW - 20 * HOUR_MS),
            None,
            Occasion::Launch
        ));
        assert!(check_due(
            NOW,
            Some(NOW - 21 * HOUR_MS),
            None,
            Occasion::Wake
        ));
    }

    #[test]
    fn looks_once_a_day_while_running() {
        assert!(!check_due(
            NOW,
            Some(NOW - 23 * HOUR_MS),
            None,
            Occasion::Running
        ));
        assert!(check_due(
            NOW,
            Some(NOW - 24 * HOUR_MS),
            None,
            Occasion::Running
        ));
    }

    #[test]
    fn waits_an_hour_after_a_failed_look() {
        let old = Some(NOW - 30 * HOUR_MS);
        assert!(!check_due(
            NOW,
            old,
            Some(NOW - 10 * 60_000),
            Occasion::Running
        ));
        assert!(check_due(NOW, old, Some(NOW - HOUR_MS), Occasion::Running));
        assert!(!check_due(NOW, None, Some(NOW - 1), Occasion::Launch));
    }

    #[test]
    fn a_clock_that_went_backwards_does_not_stop_looking() {
        assert!(check_due(NOW, Some(NOW + HOUR_MS), None, Occasion::Running));
        // A "last try" in the future doesn't block either.
        assert!(check_due(NOW, None, Some(NOW + HOUR_MS), Occasion::Running));
    }

    #[test]
    fn tells_sleep_from_a_slow_tick() {
        let min = Duration::from_secs(60);
        assert!(!slept(min + Duration::from_secs(5), min));
        assert!(slept(Duration::from_secs(3600), min));
    }

    fn quiet() -> IdleInputs {
        IdleInputs {
            daemon_up: true,
            activity: Some(Activity::default()),
            busy_terminals: Some(0),
            idle_secs: Some(900.0),
            unfocused_secs: None,
            idle_for: IDLE_FOR_SECS,
        }
    }

    #[test]
    fn installs_when_nothing_is_going_on_and_you_are_away() {
        assert!(blockers(&quiet()).is_empty());
    }

    #[test]
    fn waits_for_claude_terminals_the_room_and_you() {
        let mut i = quiet();
        i.activity = Some(Activity {
            claude: 2,
            guests: 1,
            joined: false,
        });
        i.busy_terminals = Some(1);
        i.idle_secs = Some(30.0);
        assert_eq!(
            blockers(&i),
            vec![
                Blocker::Claude,
                Blocker::Room,
                Blocker::Terminal,
                Blocker::You
            ]
        );
        let joined = IdleInputs {
            activity: Some(Activity {
                joined: true,
                ..Activity::default()
            }),
            ..quiet()
        };
        assert_eq!(blockers(&joined), vec![Blocker::Room]);
    }

    #[test]
    fn what_it_cannot_tell_counts_as_busy() {
        let i = IdleInputs {
            activity: None,
            busy_terminals: None,
            ..quiet()
        };
        assert_eq!(blockers(&i), vec![Blocker::Claude, Blocker::Terminal]);
    }

    #[test]
    fn with_no_daemon_only_you_matter() {
        let i = IdleInputs {
            daemon_up: false,
            activity: None,
            busy_terminals: None,
            ..quiet()
        };
        assert!(blockers(&i).is_empty());
    }

    #[test]
    fn falls_back_to_how_long_the_window_has_been_in_the_background() {
        let mut i = quiet();
        i.idle_secs = None;
        assert_eq!(blockers(&i), vec![Blocker::You]);
        i.unfocused_secs = Some(120.0);
        assert_eq!(blockers(&i), vec![Blocker::You]);
        i.unfocused_secs = Some(601.0);
        assert!(blockers(&i).is_empty());
    }

    #[test]
    fn finds_terminals_with_a_program_in_front() {
        let ps = "  100     1   100     0\n\
                  \x20 201   100   201   201\n\
                  \x20 202   100   202   310\n\
                  \x20 310   202   310   310\n\
                  \x20 400   100   100     0\n\
                  garbage line\n";
        let procs = parse_ps(ps);
        assert_eq!(procs.len(), 5);
        // 201: a shell at its prompt; 202: a shell running 310; 400: no terminal (Claude).
        assert_eq!(busy_terminals(&procs, 100), 1);
        assert_eq!(busy_terminals(&procs, 999), 0);
    }
}
