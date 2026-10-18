//! The menu bar and the menu-bar (tray) icon. Every item sends its id to the window, which
//! does what the same command does in the app (and in the terminal app).

use std::collections::HashMap;

use tauri::menu::{
    AboutMetadata, CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu,
};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

fn item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    keys: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, label, true, keys)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some("Klaud".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "Klaud",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Klaud"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "settings", "Settings…", Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "quit", "Quit Klaud", Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item(app, "new-chat", "New Chat", Some("CmdOrCtrl+N"))?,
            &item(
                app,
                "new-worktree",
                "New Worktree…",
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &item(app, "add-project", "Add Project…", Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "share-folder", "Share a Folder…", None)?,
            &item(app, "invite", "Invite…", Some("CmdOrCtrl+Shift+I"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(
                app,
                "find",
                "Search Conversations",
                Some("CmdOrCtrl+Shift+F"),
            )?,
        ],
    )?;
    let appearance = Submenu::with_items(
        app,
        "Appearance",
        true,
        &[
            &item(app, "appearance-system", "Match the System", None)?,
            &item(app, "appearance-light", "Light", None)?,
            &item(app, "appearance-dark", "Dark", None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item(
                app,
                "palette",
                "Everything You Can Do…",
                Some("CmdOrCtrl+K"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &item(
                app,
                "toggle-sidebar",
                "Toggle Sidebar",
                Some("Ctrl+CmdOrCtrl+S"),
            )?,
            &item(
                app,
                "toggle-inspector",
                "Toggle Inspector",
                Some("Alt+CmdOrCtrl+I"),
            )?,
            &item(
                app,
                "toggle-dock",
                "Terminal Beside Chat",
                Some("CmdOrCtrl+J"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &appearance,
            &item(app, "zoom-in", "Bigger Text", Some("CmdOrCtrl+="))?,
            &item(app, "zoom-out", "Smaller Text", Some("CmdOrCtrl+-"))?,
            &item(app, "zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            // The sidebar's order (⌥1…6 in the window too).
            &item(app, "go-room", "Chat", Some("Alt+1"))?,
            &item(app, "go-overview", "Overview", Some("Alt+2"))?,
            &item(app, "go-files", "Shared Files", Some("Alt+3"))?,
            &item(app, "go-search", "Search", Some("Alt+4"))?,
            &item(app, "go-usage", "Usage", Some("Alt+5"))?,
            &item(app, "go-terminal", "Terminal", Some("Alt+6"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(
                app,
                "ws-prev",
                "Previous Workspace",
                Some("Alt+CmdOrCtrl+Up"),
            )?,
            &item(app, "ws-next", "Next Workspace", Some("Alt+CmdOrCtrl+Down"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "inbox", "Inbox", Some("CmdOrCtrl+Shift+B"))?,
        ],
    )?;
    let conversation = conversation_menu(app)?;
    let workspace = workspace_menu(app)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "show", "Klaud", None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item(app, "help-keys", "Keys and Commands", Some("CmdOrCtrl+/"))?,
            &item(app, "help-log", "Open the Log", None)?,
        ],
    )?;
    Menu::with_items(
        app,
        &[
            &app_menu,
            &file,
            &edit,
            &view,
            &conversation,
            &workspace,
            &go,
            &window,
            &help,
        ],
    )
}

/// Your Claude in the conversation on screen: stop it, plan first, find, copy, clear.
fn conversation_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let plan = CheckMenuItem::with_id(
        app,
        "conv-plan",
        "Plan First",
        true,
        false,
        Some("Alt+CmdOrCtrl+P"),
    )?;
    Submenu::with_items(
        app,
        "Conversation",
        true,
        &[
            &item(app, "conv-stop", "Stop Claude", Some("CmdOrCtrl+."))?,
            &plan,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "conv-find", "Find…", Some("CmdOrCtrl+F"))?,
            &item(app, "conv-find-next", "Find Next", Some("CmdOrCtrl+G"))?,
            &item(
                app,
                "conv-find-prev",
                "Find Previous",
                Some("Shift+CmdOrCtrl+G"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "conv-copy", "Copy Last Answer", None)?,
            &item(
                app,
                "conv-clear",
                "Clear Conversation…",
                Some("Shift+CmdOrCtrl+K"),
            )?,
        ],
    )
}

/// The workspace on screen: its toolbar's actions, with their keys.
fn workspace_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        app,
        "Workspace",
        true,
        &[
            &item(app, "ws-commit", "Commit", Some("Shift+CmdOrCtrl+C"))?,
            &item(app, "ws-pr", "Pull Request…", Some("Shift+CmdOrCtrl+P"))?,
            &item(app, "ws-merge", "Merge", Some("Shift+CmdOrCtrl+M"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "ws-run", "Run", Some("CmdOrCtrl+R"))?,
            &item(
                app,
                "ws-review",
                "Ask Claude to Review",
                Some("Shift+CmdOrCtrl+R"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "ws-finder", "Show in Finder", None)?,
            &item(app, "ws-fork", "Fork…", None)?,
            &item(app, "ws-archive", "Archive…", Some("Ctrl+CmdOrCtrl+A"))?,
        ],
    )
}

/// What the window says about its commands right now (see `useMenuState` in lib/native.ts).
#[derive(Debug, Default, serde::Deserialize)]
pub struct MenuState {
    #[serde(default)]
    pub enabled: HashMap<String, bool>,
    #[serde(default)]
    pub checked: HashMap<String, bool>,
    #[serde(default)]
    pub labels: HashMap<String, String>,
}

/// Grey out, check and rename menu-bar items by id (only ids the menu has; others are ignored).
pub fn apply_state<R: Runtime>(menu: &Menu<R>, state: &MenuState) {
    let Ok(top) = menu.items() else { return };
    let submenus: Vec<Submenu<R>> = top
        .into_iter()
        .filter_map(|k| match k {
            MenuItemKind::Submenu(s) => Some(s),
            _ => None,
        })
        .collect();
    let find = |id: &str| submenus.iter().find_map(|s| s.get(id));
    for (id, on) in &state.enabled {
        match find(id) {
            Some(MenuItemKind::MenuItem(i)) => {
                let _ = i.set_enabled(*on);
            }
            Some(MenuItemKind::Check(i)) => {
                let _ = i.set_enabled(*on);
            }
            _ => {}
        }
    }
    for (id, on) in &state.checked {
        if let Some(MenuItemKind::Check(i)) = find(id) {
            let _ = i.set_checked(*on);
        }
    }
    for (id, text) in &state.labels {
        if let Some(MenuItemKind::MenuItem(i)) = find(id) {
            let _ = i.set_text(text);
        }
    }
}

pub fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "quit" => app.exit(0),
        "show" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
        _ => {
            let _ = app.emit("menu", id.to_string());
        }
    }
}

/// The icon in the menu bar: open klaud, or quit it (leaving the room).
pub fn tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &item(app, "show", "Open Klaud", None)?,
            &item(app, "new-chat", "New Chat", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "quit", "Quit Klaud", None)?,
        ],
    )?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("klaud")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Klaud")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}
