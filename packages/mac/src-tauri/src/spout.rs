//! The menu-bar whale spouting water (BLG-280). The window draws the frames (one drawing for
//! the menu bar and Settings' preview: src/menubar/spout.ts) and hands them over; this side plays
//! them on its own thread, so the spout stays smooth while the window is hidden or busy.

use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::{AppHandle, Manager, Runtime};

enum Cmd {
    /// The frames to play and how long each shows (none: no spout).
    Frames(Vec<Image<'static>>, Duration),
    /// Spout once now.
    Play,
    /// Spout again and again, this often (`None`: stop).
    Repeat(Option<Duration>),
}

/// The player's mailbox.
pub struct Spout(Mutex<Sender<Cmd>>);

/// The menu-bar icon at rest (decoded once, the first time a spout ends; the same picture each time).
fn rest() -> Option<Image<'static>> {
    static REST: OnceLock<Option<Image<'static>>> = OnceLock::new();
    REST.get_or_init(|| Image::from_bytes(include_bytes!("../icons/tray.png")).ok()).clone()
}

/// Start the player (once, at launch).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = channel::<Cmd>();
    app.manage(Spout(Mutex::new(tx)));
    let app = app.clone();
    thread::spawn(move || {
        let mut frames: Vec<Image<'static>> = Vec::new();
        let mut frame = Duration::from_millis(33);
        let mut every: Option<Duration> = None;
        let mut next: Option<Instant> = None;
        loop {
            let wait = next.map(|at| at.saturating_duration_since(Instant::now()));
            let cmd = match wait {
                Some(w) => match rx.recv_timeout(w) {
                    Ok(c) => Some(c),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                },
                None => match rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => return,
                },
            };
            let play = match cmd {
                Some(Cmd::Frames(f, d)) => {
                    frames = f;
                    frame = d;
                    false
                }
                Some(Cmd::Repeat(e)) => {
                    every = e;
                    next = e.map(|e| Instant::now() + e.min(Duration::from_millis(600)));
                    false
                }
                Some(Cmd::Play) => true,
                // The repeat came round.
                None => true,
            };
            if play && !frames.is_empty() {
                if let Some(tray) = app.tray_by_id("beluga") {
                    let started = Instant::now();
                    // Image and template together, in one go: `set_icon` alone puts each frame up
                    // as a plain (untinted) image until a second call marks it a template, and the
                    // bar draws it in between, so the whale flickered on every frame (BLG-335).
                    for (i, f) in frames.iter().enumerate() {
                        let _ = tray.set_icon_with_as_template(Some(f.clone()), true);
                        // Keep to the clock, not to how long setting the icon took.
                        let due = started + frame * (i as u32 + 1);
                        thread::sleep(due.saturating_duration_since(Instant::now()));
                    }
                    let _ = tray.set_icon_with_as_template(rest(), true);
                }
                // Spouts asked for while it played are the same spout.
                while let Ok(c) = rx.try_recv() {
                    match c {
                        Cmd::Frames(f, d) => {
                            frames = f;
                            frame = d;
                        }
                        Cmd::Repeat(e) => every = e,
                        Cmd::Play => {}
                    }
                }
            }
            if play || next.is_some_and(|at| at <= Instant::now()) {
                next = every.map(|e| Instant::now() + e);
            }
        }
    });
}

fn send<R: Runtime>(app: &AppHandle<R>, cmd: Cmd) {
    if let Some(s) = app.try_state::<Spout>() {
        let _ = s.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).send(cmd);
    }
}

/// The spout's frames (PNGs, first and last at rest) and how long each shows; none turns it off.
#[tauri::command]
pub fn set_tray_spout(app: AppHandle, frames: Vec<Vec<u8>>, frame_ms: u32) {
    let images = frames
        .iter()
        .filter_map(|b| Image::from_bytes(b).ok())
        .collect::<Vec<_>>();
    let frame = Duration::from_millis(u64::from(frame_ms.clamp(16, 200)));
    send(&app, Cmd::Frames(images, frame));
}

/// Spout once now (something finished), or `every_ms` again and again (Claude is working; 0 stops).
#[tauri::command]
pub fn play_tray_spout(app: AppHandle, every_ms: Option<u32>) {
    match every_ms {
        None => send(&app, Cmd::Play),
        Some(0) => send(&app, Cmd::Repeat(None)),
        Some(ms) => send(&app, Cmd::Repeat(Some(Duration::from_millis(u64::from(ms.max(1500)))))),
    }
}
