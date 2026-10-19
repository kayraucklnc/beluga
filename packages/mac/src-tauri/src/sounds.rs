//! Notification sounds, and whether macOS lets Klaud notify at all.
//!
//! Klaud's own sounds (8-bit, generated) are made in the web view and handed over as WAV
//! files; they go to `~/Library/Sounds/Klaud-….wav`, where the system finds them by name and
//! plays them with the banner (so Focus and the per-app "Play sound" switch apply). Only
//! that folder and only `Klaud-…` names are ever written or removed.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Every sound file Klaud writes starts with this.
const PREFIX: &str = "Klaud-";
/// Longest name after the prefix.
const MAX_NAME: usize = 48;
/// A few seconds of 16-bit audio is far below this; anything bigger isn't one of ours.
const MAX_WAV: usize = 2 * 1024 * 1024;
/// The sounds macOS ships in /System/Library/Sounds (shared/notify-sound.ts MAC_SOUNDS).
const SYSTEM_SOUNDS: [&str; 14] = [
    "Glass",
    "Ping",
    "Pop",
    "Purr",
    "Tink",
    "Hero",
    "Funk",
    "Submarine",
    "Blow",
    "Bottle",
    "Frog",
    "Morse",
    "Sosumi",
    "Basso",
];

/// `Klaud-` and then lowercase letters, digits and dashes: a file name that can't go anywhere else.
fn valid_name(name: &str) -> bool {
    name.strip_prefix(PREFIX).is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= MAX_NAME
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// A RIFF/WAVE file of a sensible size.
fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() > 44
        && bytes.len() <= MAX_WAV
        && &bytes[0..4] == b"RIFF"
        && &bytes[8..12] == b"WAVE"
}

fn sounds_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join("Library").join("Sounds"))
        .ok_or_else(|| "Couldn't find your home folder".to_string())
}

/// Write `name.wav` into `dir` (atomically; unchanged files are left alone).
fn install_in(dir: &Path, name: &str, wav: &[u8]) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("Not a Klaud sound name: {name}"));
    }
    if !is_wav(wav) {
        return Err("That isn't a WAV file Klaud made".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let file = dir.join(format!("{name}.wav"));
    if std::fs::read(&file).is_ok_and(|old| old == wav) {
        return Ok(());
    }
    let tmp = dir.join(format!(".{name}.wav.tmp"));
    std::fs::write(&tmp, wav).map_err(|e| format!("Couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &file).map_err(|e| format!("Couldn't save {}: {e}", file.display()))
}

/// Remove Klaud's sound files in `dir` that aren't in `keep`. Returns how many went.
fn prune_in(dir: &Path, keep: &[String]) -> u32 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(stem) = file.to_str().and_then(|f| f.strip_suffix(".wav")) else {
            continue;
        };
        if valid_name(stem)
            && !keep.iter().any(|k| k == stem)
            && std::fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// Put one of Klaud's sounds where notifications can play it; returns the name to ask for.
#[tauri::command]
pub async fn sound_install(name: String, wav: Vec<u8>) -> Result<String, String> {
    install_in(&sounds_dir()?, &name, &wav)?;
    Ok(name)
}

/// Remove Klaud's sounds nobody chose any more.
#[tauri::command]
pub async fn sound_prune(keep: Vec<String>) -> Result<u32, String> {
    Ok(prune_in(&sounds_dir()?, &keep))
}

/// Play one of the Mac's own sounds (a preview in Settings).
#[tauri::command]
pub fn sound_play_system(name: String) -> Result<(), String> {
    if !SYSTEM_SOUNDS.contains(&name.as_str()) {
        return Err(format!("Not a Mac sound: {name}"));
    }
    let mut child = std::process::Command::new("/usr/bin/afplay")
        .arg(format!("/System/Library/Sounds/{name}.aiff"))
        .spawn()
        .map_err(|e| format!("Couldn't play {name}: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Whether macOS lets Klaud notify, as Settings › Notifications shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// "allowed", "off" (turned off in System Settings), "notAsked", or "unknown" (can't tell).
    pub state: &'static str,
    /// Banners or alerts are on (not just Notification Center).
    pub alerts: bool,
    /// "Play sound for notifications" is on.
    pub sound: bool,
}

impl Access {
    const UNKNOWN: Access = Access {
        state: "unknown",
        alerts: true,
        sound: true,
    };
}

/// What macOS says about Klaud's notifications right now.
#[tauri::command]
pub async fn notification_access() -> Access {
    tauri::async_runtime::spawn_blocking(mac::access)
        .await
        .unwrap_or(Access::UNKNOWN)
}

/// Open System Settings › Notifications (at Klaud, where macOS supports that).
#[tauri::command]
pub fn open_notification_settings(app: tauri::AppHandle) -> Result<(), String> {
    let id = &app.config().identifier;
    let url =
        format!("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={id}");
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open System Settings: {e}"))
}

/// Show notifications even while Klaud is the app in front (see `mac::present_in_front`).
pub fn present_in_front() {
    mac::present_in_front();
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Access;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{sel, Encode};
    use objc2_user_notifications::{
        UNAuthorizationStatus, UNNotificationSetting, UNNotificationSettings,
        UNUserNotificationCenter,
    };
    use std::ffi::CString;
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    /// The delegate the notification plugin installs (mac-notification-sys's `notify.m`).
    const DELEGATE: &std::ffi::CStr = c"NotificationCenterDelegate";

    extern "C-unwind" fn should_present(
        _this: *mut AnyObject,
        _cmd: Sel,
        _center: *mut AnyObject,
        _note: *mut AnyObject,
    ) -> Bool {
        Bool::YES
    }

    /// macOS only shows a banner (and plays its sound) while the app is in the background,
    /// unless the delegate's `userNotificationCenter:shouldPresentNotification:` says yes, and
    /// the plugin's delegate doesn't have one. Klaud already decides what's worth showing (it
    /// never notifies about what you're looking at; "Only when Klaud isn't in front" is a
    /// setting), so it always says yes.
    pub fn present_in_front() {
        let Some(class) = AnyClass::get(DELEGATE) else {
            eprintln!("klaud: the notification delegate wasn't found; banners only show while Klaud is in the background");
            return;
        };
        let Ok(types) = CString::new(format!("{}@:@@", Bool::ENCODING)) else {
            return;
        };
        // SAFETY: `should_present` has exactly the signature the selector's type string says
        // (BOOL, self, _cmd, two objects). class_addMethod leaves an existing method alone.
        unsafe {
            let imp: Imp = std::mem::transmute(
                should_present
                    as extern "C-unwind" fn(
                        *mut AnyObject,
                        Sel,
                        *mut AnyObject,
                        *mut AnyObject,
                    ) -> Bool,
            );
            objc2::ffi::class_addMethod(
                class as *const AnyClass as *mut AnyClass,
                sel!(userNotificationCenter:shouldPresentNotification:),
                imp,
                types.as_ptr(),
            );
        }
    }

    /// Only an app bundle has notification settings (`tauri dev` runs the bare binary, where
    /// asking would raise an exception).
    fn in_app_bundle() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.to_str().map(|p| p.contains(".app/Contents/MacOS/")))
            .unwrap_or(false)
    }

    pub fn access() -> Access {
        if !in_app_bundle() {
            return Access::UNKNOWN;
        }
        let (tx, rx) = mpsc::channel();
        let block = block2::RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: the system hands us a valid settings object for the call's duration.
            let s = unsafe { settings.as_ref() };
            let _ = tx.send(read(s));
        });
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.getNotificationSettingsWithCompletionHandler(&block);
        rx.recv_timeout(Duration::from_secs(3))
            .unwrap_or(Access::UNKNOWN)
    }

    fn read(s: &UNNotificationSettings) -> Access {
        let status = s.authorizationStatus();
        let state = if status == UNAuthorizationStatus::Denied {
            "off"
        } else if status == UNAuthorizationStatus::NotDetermined {
            "notAsked"
        } else {
            "allowed"
        };
        Access {
            state,
            alerts: s.alertSetting() != UNNotificationSetting::Disabled,
            sound: s.soundSetting() != UNNotificationSetting::Disabled,
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::Access;
    pub fn present_in_front() {}
    pub fn access() -> Access {
        Access::UNKNOWN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(len: usize) -> Vec<u8> {
        let mut v = vec![0u8; len];
        v[0..4].copy_from_slice(b"RIFF");
        v[8..12].copy_from_slice(b"WAVE");
        v
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klaud-sounds-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_klaud_names_are_accepted() {
        assert!(valid_name("Klaud-chip-coin-70"));
        assert!(valid_name("Klaud-gen-0a1b2c3d-55"));
        for bad in [
            "Klaud-",
            "Glass",
            "klaud-x",
            "Klaud-../x",
            "Klaud-a/b",
            "Klaud-A",
            "Klaud-a.wav",
            "Klaud-a b",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(!valid_name(&format!("Klaud-{}", "a".repeat(MAX_NAME + 1))));
    }

    #[test]
    fn only_wav_files_of_a_sensible_size_are_written() {
        assert!(is_wav(&wav(100)));
        assert!(!is_wav(&wav(44)));
        assert!(!is_wav(&wav(MAX_WAV + 1)));
        let mut aiff = wav(100);
        aiff[8..12].copy_from_slice(b"AIFF");
        assert!(!is_wav(&aiff));
    }

    #[test]
    fn installs_and_prunes_only_klaud_sounds() {
        let dir = scratch("prune");
        install_in(&dir, "Klaud-chip-coin-70", &wav(100)).unwrap();
        install_in(&dir, "Klaud-gen-00000001-70", &wav(120)).unwrap();
        // The same file again is fine (left alone).
        install_in(&dir, "Klaud-chip-coin-70", &wav(100)).unwrap();
        std::fs::write(dir.join("Mine.aiff"), b"x").unwrap();
        std::fs::write(dir.join("Klaud-Other.wav"), b"x").unwrap();
        assert!(install_in(&dir, "../evil", &wav(100)).is_err());
        assert!(install_in(&dir, "Klaud-x", b"not a wav").is_err());

        assert_eq!(prune_in(&dir, &["Klaud-chip-coin-70".to_string()]), 1);
        assert!(dir.join("Klaud-chip-coin-70.wav").exists());
        assert!(!dir.join("Klaud-gen-00000001-70.wav").exists());
        // Not ours (or not a name Klaud makes): never touched.
        assert!(dir.join("Mine.aiff").exists());
        assert!(dir.join("Klaud-Other.wav").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_notification_delegate_learns_to_present_in_front() {
        use objc2::runtime::AnyClass;
        use objc2::sel;
        // The plugin's delegate class is linked in through tauri-plugin-notification.
        let Some(class) = AnyClass::get(c"NotificationCenterDelegate") else {
            panic!(
                "mac-notification-sys's delegate class is gone: present_in_front needs updating"
            );
        };
        present_in_front();
        assert!(class
            .instance_method(sel!(userNotificationCenter:shouldPresentNotification:))
            .is_some());
        // Doing it twice is harmless.
        present_in_front();
    }

    #[test]
    fn only_mac_sounds_are_played() {
        assert!(sound_play_system("../../bin/sh".into()).is_err());
        assert!(sound_play_system("glass".into()).is_err());
    }
}
