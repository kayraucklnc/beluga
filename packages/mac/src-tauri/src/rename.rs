//! Klaud became Beluga, and macOS sees a new bundle id as a new app: its own Application
//! Support folder, its own web view storage (localStorage), its own notification permission.
//! On the first launch of Beluga this brings over what Klaud kept, and an update that landed in
//! /Applications/Klaud.app (the updater puts the new app where the old one was) moves to
//! Beluga.app. Nothing old is deleted, so going back to an older Klaud still finds everything.
//! See docs/mac-rename.md.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The bundle id before the rename, and the one after.
const OLD_ID: &str = "sh.klaud.mac";
const NEW_ID: &str = "io.github.kayraucklnc.beluga";
/// The binary's name before and after: the web view's storage is named for it in development
/// (`tauri dev` runs the binary outside a bundle).
const OLD_EXE: &str = "klaud-mac";
const NEW_EXE: &str = "beluga-mac";
/// The app's folder name before and after.
const OLD_APP: &str = "Klaud.app";
const NEW_APP: &str = "Beluga.app";

/// The id Klaud had for this one: `io.github.kayraucklnc.beluga.debug` was `sh.klaud.mac.debug`
/// (the local update test builds with a suffix). `None` for an id that never was Klaud's.
pub fn old_identifier(identifier: &str) -> Option<String> {
    identifier
        .strip_prefix(NEW_ID)
        .filter(|rest| rest.is_empty() || rest.starts_with('.'))
        .map(|rest| format!("{OLD_ID}{rest}"))
}

/// The folders (under ~/Library) to bring over, old → new, for this app.
pub fn moves(identifier: &str, in_bundle: bool) -> Vec<(PathBuf, PathBuf)> {
    let Some(old) = old_identifier(identifier) else {
        return Vec::new();
    };
    let mut list = vec![
        // updates.json (the Updates setting, a waiting update) and .window-state.json.
        (
            Path::new("Application Support").join(&old),
            Path::new("Application Support").join(identifier),
        ),
    ];
    // localStorage, IndexedDB and the rest of the web view's data.
    if in_bundle {
        list.push((
            Path::new("WebKit").join(&old),
            Path::new("WebKit").join(identifier),
        ));
    } else {
        list.push((
            Path::new("WebKit").join(OLD_EXE),
            Path::new("WebKit").join(NEW_EXE),
        ));
    }
    list
}

/// Copy `from` to `to` when `to` isn't there yet: into a temporary folder first, renamed into
/// place at the end, so a copy cut short is never mistaken for a finished one. Returns whether
/// anything was copied.
pub fn bring_over(from: &Path, to: &Path) -> std::io::Result<bool> {
    if to.symlink_metadata().is_ok() || !from.is_dir() {
        return Ok(false);
    }
    let parent = to.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let name = to
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = parent.join(format!(".{name}.migrating-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let copied = copy_dir(from, &tmp).and_then(|()| std::fs::rename(&tmp, to));
    if copied.is_err() {
        let _ = std::fs::remove_dir_all(&tmp);
    }
    copied.map(|()| true)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &target)?;
            // Klaud was only ever a Mac app: nothing to bring over anywhere else.
            #[cfg(not(unix))]
            std::fs::copy(entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Bring Klaud's settings, window place and web view data over (once; before any of them is
/// read: this runs before Tauri starts).
pub fn migrate_data(identifier: &str, in_bundle: bool) {
    let Some(library) = dirs::home_dir().map(|h| h.join("Library")) else {
        return;
    };
    for (from, to) in moves(identifier, in_bundle) {
        match bring_over(&library.join(&from), &library.join(&to)) {
            Ok(true) => eprintln!(
                "beluga: brought {} over to {}",
                from.display(),
                to.display()
            ),
            Ok(false) => {}
            Err(e) => eprintln!("beluga: couldn't bring {} over: {e}", from.display()),
        }
    }
}

/// Where an updated Klaud.app should go: Beluga.app next to it, unless that is already there,
/// or the app runs from a place it can't stay (a disk image, or macOS's translocation copy).
pub fn renamed_bundle(bundle: &Path) -> Option<PathBuf> {
    if bundle.file_name()? != OLD_APP {
        return None;
    }
    let text = bundle.to_string_lossy();
    if text.contains("/AppTranslocation/") || text.starts_with("/Volumes/") {
        return None;
    }
    let target = bundle.with_file_name(NEW_APP);
    target.symlink_metadata().is_err().then_some(target)
}

const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// Running from /Applications/Klaud.app after the update to Beluga: become Beluga.app, tell
/// Launch Services (so beluga:// and klaud:// links open it), and start again from there.
/// Returns `true` when this process should quit right away (the renamed app is starting).
pub fn move_bundle(bundle: Option<&Path>, keep_env: &[&str]) -> bool {
    let Some((bundle, target)) = bundle.and_then(|b| Some((b, renamed_bundle(b)?))) else {
        return false;
    };
    if let Err(e) = std::fs::rename(bundle, &target) {
        // /Applications may not be ours to change: Beluga runs fine under the old name.
        eprintln!(
            "beluga: couldn't rename {} to {NEW_APP}: {e}",
            bundle.display()
        );
        return false;
    }
    let _ = Command::new(LSREGISTER)
        .arg("-f")
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let mut args = vec!["-n".to_string()];
    for name in keep_env {
        if let Ok(value) = std::env::var(name) {
            args.push("--env".into());
            args.push(format!("{name}={value}"));
        }
    }
    args.push(target.to_string_lossy().into_owned());
    let passed: Vec<String> = std::env::args().skip(1).collect();
    if !passed.is_empty() {
        args.push("--args".into());
        args.extend(passed);
    }
    match Command::new("/usr/bin/open")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => true,
        Err(e) => {
            // Couldn't start it: put the app back where this one runs from, and carry on.
            eprintln!("beluga: couldn't open {}: {e}", target.display());
            let _ = std::fs::rename(&target, bundle);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("beluga-rename-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn knows_klauds_id_for_each_beluga_id() {
        assert_eq!(old_identifier(NEW_ID).as_deref(), Some(OLD_ID));
        assert_eq!(
            old_identifier("io.github.kayraucklnc.beluga.debug").as_deref(),
            Some("sh.klaud.mac.debug")
        );
        assert_eq!(old_identifier("io.github.kayraucklnc.belugax"), None);
        assert_eq!(old_identifier("com.example.other"), None);
        assert!(moves("com.example.other", true).is_empty());
    }

    #[test]
    fn moves_application_support_and_web_storage() {
        let bundled = moves(NEW_ID, true);
        assert_eq!(
            bundled,
            vec![
                (
                    PathBuf::from("Application Support/sh.klaud.mac"),
                    PathBuf::from("Application Support/io.github.kayraucklnc.beluga")
                ),
                (
                    PathBuf::from("WebKit/sh.klaud.mac"),
                    PathBuf::from("WebKit/io.github.kayraucklnc.beluga")
                ),
            ]
        );
        let dev = moves(NEW_ID, false);
        assert_eq!(
            dev[1],
            (
                PathBuf::from("WebKit/klaud-mac"),
                PathBuf::from("WebKit/beluga-mac")
            )
        );
    }

    #[test]
    fn brings_everything_over_once_and_keeps_the_old() {
        let lib = temp("data");
        let old = lib.join("Application Support/sh.klaud.mac");
        std::fs::create_dir_all(old.join("nested")).unwrap();
        std::fs::write(old.join("updates.json"), r#"{"mode":"idle"}"#).unwrap();
        std::fs::write(old.join(".window-state.json"), r#"{"main":{"x":10}}"#).unwrap();
        std::fs::write(old.join("nested/localstorage.sqlite3"), b"db").unwrap();
        let new = lib.join("Application Support/io.github.kayraucklnc.beluga");

        assert!(bring_over(&old, &new).unwrap());
        assert_eq!(
            std::fs::read_to_string(new.join("updates.json")).unwrap(),
            r#"{"mode":"idle"}"#
        );
        assert_eq!(
            std::fs::read_to_string(new.join(".window-state.json")).unwrap(),
            r#"{"main":{"x":10}}"#
        );
        assert_eq!(
            std::fs::read(new.join("nested/localstorage.sqlite3")).unwrap(),
            b"db"
        );
        // The old folder stays, for an older Klaud.
        assert!(old.join("updates.json").exists());
        // No leftovers from the copy.
        let names: Vec<_> = std::fs::read_dir(new.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|n| !n.contains("migrating")), "{names:?}");

        // Second launch: Beluga's own settings are never overwritten.
        std::fs::write(new.join("updates.json"), r#"{"mode":"off"}"#).unwrap();
        assert!(!bring_over(&old, &new).unwrap());
        assert_eq!(
            std::fs::read_to_string(new.join("updates.json")).unwrap(),
            r#"{"mode":"off"}"#
        );

        // Nothing from Klaud: nothing to do.
        assert!(!bring_over(&lib.join("missing"), &lib.join("new")).unwrap());
        assert!(!lib.join("new").exists());
        let _ = std::fs::remove_dir_all(&lib);
    }

    #[test]
    fn an_updated_klaud_app_becomes_beluga_app() {
        let apps = temp("apps");
        let klaud = apps.join("Klaud.app");
        std::fs::create_dir_all(&klaud).unwrap();
        assert_eq!(renamed_bundle(&klaud), Some(apps.join("Beluga.app")));
        // Already Beluga, or Beluga.app is there too (installed from the disk image): stay.
        assert_eq!(renamed_bundle(&apps.join("Beluga.app")), None);
        std::fs::create_dir_all(apps.join("Beluga.app")).unwrap();
        assert_eq!(renamed_bundle(&klaud), None);
        // Run from the disk image or a translocated copy: never renamed.
        assert_eq!(renamed_bundle(Path::new("/Volumes/Klaud/Klaud.app")), None);
        assert_eq!(
            renamed_bundle(Path::new(
                "/private/var/folders/x/AppTranslocation/y/d/Klaud.app"
            )),
            None
        );
        let _ = std::fs::remove_dir_all(&apps);
    }
}
