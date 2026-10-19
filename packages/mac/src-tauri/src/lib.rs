//! klaud for macOS: the native shell around the web view.
//!
//! The app owns only what the operating system is for: the window (vibrancy, traffic lights),
//! the menu bar, the tray, notifications, `klaud://` links, and keeping klaud's daemon running.
//! Everything klaud does happens in the daemon, which the terminal app attaches to as well.

mod daemon;
mod focus;
mod menu;
mod popup;
mod requests;
mod sounds;
mod update_rules;
mod updater;

use std::collections::HashMap;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_notification::NotificationExt;

/// What the app keeps track of while it runs.
pub struct AppState {
    /// Held while klaud is started or restarted, so two requests never start two daemons.
    pub lock: tokio::sync::Mutex<()>,
    /// The daemon this app started (it stops it on quit), if any.
    pub child: Mutex<Option<Child>>,
    /// Links that arrived before the window was listening.
    pub pending_links: Mutex<Vec<String>>,
    /// Whether the window has asked for those links yet.
    pub links_taken: AtomicBool,
}

#[tauri::command]
async fn daemon_endpoint(app: tauri::AppHandle) -> Result<daemon::Endpoint, String> {
    daemon::ensure(&app, &[]).await
}

/// Start klaud again with these arguments (joining a friend's room from a link): the current
/// room is left first. Only `["join", "<invite link>"]` is accepted.
#[tauri::command]
async fn restart_daemon(
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<daemon::Endpoint, String> {
    daemon::restart(&app, &args).await
}

/// The klaud:// links that opened the app before the window was ready to hear about them
/// (handed over once).
#[tauri::command]
fn take_pending_links(state: tauri::State<'_, AppState>) -> Vec<String> {
    state.links_taken.store(true, Ordering::SeqCst);
    std::mem::take(&mut *daemon::locked(&state.pending_links))
}

/// Grey out menu-bar items that can't run right now, check toggles, rename Run/Stop Running.
#[tauri::command]
fn set_menu_state(
    app: tauri::AppHandle,
    enabled: HashMap<String, bool>,
    checked: HashMap<String, bool>,
    labels: HashMap<String, String>,
) {
    if let Some(m) = app.menu() {
        menu::apply_state(
            &m,
            &menu::MenuState {
                enabled,
                checked,
                labels,
            },
        );
    }
}

/// What the menu-bar icon and the Dock icon say: how many things are new for you (unread
/// notifications and what waits on you), and how many Claudes are working.
#[tauri::command]
fn set_tray_status(app: tauri::AppHandle, waiting: u32, working: u32, unread: Option<u32>) {
    let unread = unread.unwrap_or(waiting);
    if let Some(tray) = app.tray_by_id("klaud") {
        let _ = tray.set_title(if unread > 0 {
            Some(unread.to_string())
        } else {
            None
        });
        let _ = tray.set_tooltip(Some(tray_tip(waiting, working, unread)));
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count((unread > 0).then_some(i64::from(unread)));
    }
}

/// Your klaud network status in the menu-bar menu (`None`: the network is off, no status items).
#[tauri::command]
fn set_tray_presence(app: tauri::AppHandle, presence: Option<menu::TrayPresence>) {
    requests::set_presence(&app, presence);
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

/// Seconds since you last used the keyboard, mouse or trackpad anywhere on the Mac (for Away
/// when idle); `None` where the system can't say.
#[tauri::command]
fn system_idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        // The combined session state (0) and any input event (all bits set): what macOS itself
        // uses for idle time. SAFETY: a pure query with plain-number arguments.
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        secs.is_finite().then_some(secs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// "Klaud · 2 waiting for you · 3 new · 1 Claude working", leaving out what's zero.
fn tray_tip(waiting: u32, working: u32, unread: u32) -> String {
    let mut parts = vec!["Klaud".to_string()];
    if waiting > 0 {
        parts.push(format!("{waiting} waiting for you"));
    }
    let news = unread.saturating_sub(waiting);
    if news > 0 {
        parts.push(format!("{news} new"));
    }
    if working > 0 {
        parts.push(format!(
            "{working} Claude{} working",
            if working == 1 { "" } else { "s" }
        ));
    }
    parts.join(" · ")
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The quiet relaunch after an update installed while you were away: no window, no focus.
    let background = updater::launched_in_background();
    let mut context = tauri::generate_context!();
    if background {
        for w in &mut context.config_mut().app.windows {
            w.visible = false;
        }
    }
    let window_state = if background {
        tauri_plugin_window_state::StateFlags::all()
            - tauri_plugin_window_state::StateFlags::VISIBLE
    } else {
        tauri_plugin_window_state::StateFlags::all()
    };
    let app = tauri::Builder::default()
        .activate_ignoring_other_apps(!background)
        // A klaud:// link opened while klaud runs is passed on to the link handler below.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state)
                // The request pop-up places itself (and is never restored visible).
                .with_denylist(&[popup::LABEL])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Updates::default())
        .manage(requests::TrayState::default())
        .manage(popup::PopupState::default())
        .manage(AppState {
            lock: tokio::sync::Mutex::new(()),
            child: Mutex::new(None),
            pending_links: Mutex::new(Vec::new()),
            links_taken: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            daemon_endpoint,
            restart_daemon,
            set_menu_state,
            set_tray_status,
            set_tray_presence,
            requests::set_tray_requests,
            popup::set_request_popup,
            popup::request_popup_state,
            popup::request_popup_resize,
            popup::request_popup_dismiss,
            popup::request_popup_action,
            system_idle_seconds,
            take_pending_links,
            sounds::sound_install,
            sounds::sound_prune,
            sounds::sound_play_system,
            sounds::notification_access,
            sounds::open_notification_settings,
            sounds::open_focus_settings,
            updater::update_state,
            updater::update_check,
            updater::update_set_mode,
            updater::update_choose,
            updater::update_activity,
            updater::update_dismiss_news
        ])
        .menu(menu::build)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "check-updates" => updater::check_from_menu(app),
            id => menu::on_event(app, id),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{
                        apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
                    };
                    let _ = apply_vibrancy(
                        &window,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::FollowsWindowActiveState),
                        None,
                    );
                }
            }
            menu::tray(&handle)?;
            // Banners (and their sound) even while Klaud is in front.
            sounds::present_in_front();
            // A friend's request on a notification: Review… / Approve / Always Allow / Decline.
            requests::register_actions(&handle)?;
            // Clicking a notification brings the window back and tells it where to go.
            let taps = handle.clone();
            app.notification().on_action(move |performed| {
                if requests::on_notification(&taps, performed) {
                    return;
                }
                if performed.action_id() != "tap" {
                    return;
                }
                focus_main(&taps);
                let channel = performed
                    .notification()
                    .and_then(|n| n.extra().get("channel"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                let _ = taps.emit("notification-tap", channel);
            })?;
            // klaud:// links: join a friend's room.
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    focus_main(&links);
                    // Until the window has asked, keep the link for it: it can't hear us yet.
                    if let Some(state) = links.try_state::<AppState>() {
                        if !state.links_taken.load(Ordering::SeqCst) {
                            daemon::locked(&state.pending_links).push(url.to_string());
                        }
                    }
                    let _ = links.emit("deep-link", url.to_string());
                }
            });
            // Start klaud's daemon right away, so the window has something to show.
            tauri::async_runtime::spawn(async move {
                let _ = daemon::ensure(&handle, &[]).await;
            });
            updater::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps klaud (and your room) running in the menu bar.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("Klaud couldn't start");

    app.run(|app, event| match event {
        // Clicking the Dock icon brings the window back.
        RunEvent::Reopen { .. } => focus_main(app),
        // Quitting leaves the room (unless the terminal app started klaud; it decides then),
        // then puts a downloaded update in place.
        RunEvent::Exit => {
            daemon::stop(app);
            updater::on_exit(app);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::tray_tip;

    #[test]
    fn the_tray_tip_says_only_what_is_there() {
        assert_eq!(tray_tip(0, 0, 0), "Klaud");
        assert_eq!(tray_tip(2, 0, 2), "Klaud · 2 waiting for you");
        assert_eq!(
            tray_tip(1, 2, 4),
            "Klaud · 1 waiting for you · 3 new · 2 Claudes working"
        );
        assert_eq!(tray_tip(0, 1, 0), "Klaud · 1 Claude working");
    }
}
