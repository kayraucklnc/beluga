//! Whether a macOS Focus (Do Not Disturb, Work, Sleep…) is on right now.
//!
//! While one is, macOS holds Klaud's banners in Notification Center and mutes their sound
//! (unless Klaud is one of its allowed apps). There's no public API for this without an
//! entitlement an ad-hoc signed app can't have, so this reads the files the Focus daemon keeps
//! in ~/Library/DoNotDisturb/DB. macOS protects that folder: without Full Disk Access the read
//! fails and the answer is "can't tell", which the window turns into a quiet hint instead.

use serde_json::Value;
use std::path::PathBuf;

/// Seconds between 1970-01-01 and 2001-01-01 (the Focus files count from the latter).
const APPLE_EPOCH: f64 = 978_307_200.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Focus {
    /// None is on.
    Off,
    /// One is on (its name, when the mode file says).
    On(Option<String>),
    /// The files couldn't be read or understood.
    Unknown,
}

fn db_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join("Library").join("DoNotDisturb").join("DB"))
}

/// What the Focus files say now.
pub fn current() -> Focus {
    let Some(dir) = db_dir() else {
        return Focus::Unknown;
    };
    let Ok(assertions) = std::fs::read_to_string(dir.join("Assertions.json")) else {
        return Focus::Unknown;
    };
    let modes = std::fs::read_to_string(dir.join("ModeConfigurations.json")).ok();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() - APPLE_EPOCH)
        .unwrap_or(0.0);
    focus_from(&assertions, modes.as_deref(), now)
}

/// The numbers under `key` in each of `records`.
fn times<'a>(records: &'a [Value], key: &'a str) -> impl Iterator<Item = f64> + 'a {
    records.iter().filter_map(move |r| r.get(key)?.as_f64())
}

/// A lifetime with an end date that has passed.
fn ended(lifetime: Option<&Value>, now: f64) -> bool {
    lifetime.and_then(Value::as_object).is_some_and(|l| {
        l.iter()
            .any(|(k, v)| k.contains("EndDate") && v.as_f64().is_some_and(|end| end < now))
    })
}

/// The name of the mode `id` (`com.apple.donotdisturb.mode.default` → "Do Not Disturb").
fn mode_name(modes: &str, id: &str) -> Option<String> {
    let modes: Value = serde_json::from_str(modes).ok()?;
    modes
        .get("data")?
        .as_array()?
        .iter()
        .find_map(|d| {
            d.get("modeConfigurations")?
                .get(id)?
                .get("mode")?
                .get("name")?
                .as_str()
        })
        .map(str::to_owned)
}

/// A Focus is on when an assertion was made after the last time they were all cleared, and
/// hasn't reached its end date. `now` counts from 2001 like the files.
pub fn focus_from(assertions: &str, modes: Option<&str>, now: f64) -> Focus {
    let Ok(json) = serde_json::from_str::<Value>(assertions) else {
        return Focus::Unknown;
    };
    let Some(stores) = json.get("data").and_then(Value::as_array) else {
        return Focus::Unknown;
    };
    for store in stores {
        let list = |key: &str| {
            store
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        };
        let cleared = times(
            &list("storeInvalidationRequestRecords"),
            "invalidationRequestDateTimestamp",
        )
        .fold(f64::NEG_INFINITY, f64::max);
        for record in list("storeAssertionRecords") {
            let started = record
                .get("assertionStartDateTimestamp")
                .and_then(Value::as_f64)
                .unwrap_or(f64::INFINITY);
            let details = record.get("assertionDetails");
            if started < cleared
                || ended(details.and_then(|d| d.get("assertionDetailsLifetime")), now)
            {
                continue;
            }
            let id = details
                .and_then(|d| d.get("assertionDetailsModeIdentifier"))
                .and_then(Value::as_str);
            return Focus::On(id.zip(modes).and_then(|(id, m)| mode_name(m, id)));
        }
    }
    Focus::Off
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODES: &str = r#"{"data":[{"modeConfigurations":{
        "com.apple.donotdisturb.mode.default":{"mode":{"name":"Do Not Disturb"}},
        "com.apple.focus.work":{"mode":{"name":"Work"}}}}]}"#;

    fn assertions(records: &str, cleared: Option<f64>) -> String {
        let inv = cleared
            .map(|t| format!(r#"[{{"invalidationRequestDateTimestamp":{t}}}]"#))
            .unwrap_or_else(|| "[]".into());
        format!(
            r#"{{"data":[{{"storeAssertionRecords":{records},"storeInvalidationRequestRecords":{inv}}}]}}"#
        )
    }

    fn record(mode: &str, start: f64, lifetime: &str) -> String {
        format!(
            r#"[{{"assertionStartDateTimestamp":{start},"assertionDetails":{{"assertionDetailsModeIdentifier":"{mode}","assertionDetailsLifetime":{lifetime}}}}}]"#
        )
    }

    #[test]
    fn do_not_disturb_turned_on_by_hand_is_on() {
        // The shape on macOS 26: cleared and turned on again in the same instant.
        let a = assertions(
            &record(
                "com.apple.donotdisturb.mode.default",
                812_982_978.9,
                r#"{"assertionDetailsLifetimeType":"schedule"}"#,
            ),
            Some(812_982_978.9),
        );
        assert_eq!(
            focus_from(&a, Some(MODES), 813_000_000.0),
            Focus::On(Some("Do Not Disturb".into()))
        );
        // Without the mode file it's still on, just unnamed.
        assert_eq!(focus_from(&a, None, 813_000_000.0), Focus::On(None));
    }

    #[test]
    fn nothing_asserted_or_cleared_since_is_off() {
        assert_eq!(
            focus_from(&assertions("[]", Some(5.0)), Some(MODES), 10.0),
            Focus::Off
        );
        let stale = assertions(&record("com.apple.focus.work", 5.0, "{}"), Some(6.0));
        assert_eq!(focus_from(&stale, Some(MODES), 10.0), Focus::Off);
    }

    #[test]
    fn a_focus_until_a_time_that_has_passed_is_off() {
        let until = |end: f64| {
            assertions(
                &record(
                    "com.apple.focus.work",
                    5.0,
                    &format!(r#"{{"assertionDetailsDateLifetimeEndDateTimestamp":{end}}}"#),
                ),
                None,
            )
        };
        assert_eq!(focus_from(&until(8.0), Some(MODES), 10.0), Focus::Off);
        assert_eq!(
            focus_from(&until(20.0), Some(MODES), 10.0),
            Focus::On(Some("Work".into()))
        );
    }

    #[test]
    fn files_it_cannot_understand_say_unknown() {
        assert_eq!(focus_from("not json", Some(MODES), 0.0), Focus::Unknown);
        assert_eq!(
            focus_from(r#"{"header":{}}"#, Some(MODES), 0.0),
            Focus::Unknown
        );
    }
}
