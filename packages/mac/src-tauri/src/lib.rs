//! klaud for macOS: the native shell around the web view.
//!
//! The app owns only what the operating system is for: the window (vibrancy, traffic lights),
//! the menu bar, the tray, notifications, `klaud://` links, and keeping klaud's daemon running.
//! Everything klaud does happens in the daemon, which the terminal app attaches to as well.

mod daemon;
mod menu;

use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// The daemon this app started (it stops it on quit), if any.
pub struct AppState {
    pub started: Mutex<Option<u32>>,
}

#[tauri::command]
async fn daemon_endpoint(app: tauri::AppHandle) -> Result<daemon::Endpoint, String> {
    daemon::ensure(&app, &[]).await
}

/// Start klaud again with these arguments (joining a friend's room from a link): the current
/// room is left first.
#[tauri::command]
async fn restart_daemon(
    app: tauri::AppHandle,
    args: Vec<String>,
) -> Result<daemon::Endpoint, String> {
    daemon::stop(&app);
    daemon::ensure(&app, &args).await
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            focus_main(app);
            // A klaud:// link opened while klaud was running arrives here.
            if let Some(url) = args.iter().find(|a| a.starts_with("klaud://")) {
                let _ = app.emit("deep-link", url.clone());
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(AppState {
            started: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![daemon_endpoint, restart_daemon])
        .menu(menu::build)
        .on_menu_event(|app, event| menu::on_event(app, event.id().as_ref()))
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
            // klaud:// links: join a friend's room.
            let links = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    focus_main(&links);
                    let _ = links.emit("deep-link", url.to_string());
                }
            });
            // Start klaud's daemon right away, so the window has something to show.
            tauri::async_runtime::spawn(async move {
                let _ = daemon::ensure(&handle, &[]).await;
            });
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
        .build(tauri::generate_context!())
        .expect("klaud couldn't start");

    app.run(|app, event| match event {
        // Clicking the Dock icon brings the window back.
        RunEvent::Reopen { .. } => focus_main(app),
        // Quitting leaves the room (unless the terminal app started klaud; it decides then).
        RunEvent::Exit => daemon::stop(app),
        _ => {}
    });
}
