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
            // Handled in lib.rs (updater.rs): it works even while the window can't reach klaud.
            &item(app, "check-updates", "Check for Updates…", None)?,
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
            &item(app, "add-friend", "Add a Friend…", None)?,
            &item(app, "new-group", "New Channel…", None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "onboarding", "Onboard Again…", None)?,
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
            // The right panel (Xcode's inspector keys: ⌥⌘0 shows and hides it, ⌥⌘1…4 pick a tab).
            &item(
                app,
                "toggle-inspector",
                "Toggle Panel",
                Some("Alt+CmdOrCtrl+0"),
            )?,
            &item(app, "panel-changes", "Changes", Some("Alt+CmdOrCtrl+1"))?,
            &item(app, "panel-files", "Files", Some("Alt+CmdOrCtrl+2"))?,
            &item(app, "panel-terminal", "Terminal", Some("Alt+CmdOrCtrl+3"))?,
            &item(app, "panel-info", "Info", Some("Alt+CmdOrCtrl+4"))?,
            &item(app, "panel-history", "History", Some("Alt+CmdOrCtrl+5"))?,
            &item(app, "panel-scratch", "Scratch", Some("Alt+CmdOrCtrl+6"))?,
            &item(app, "panel-background", "Background", Some("Alt+CmdOrCtrl+7"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "toggle-dock", "Toggle Terminal", Some("CmdOrCtrl+J"))?,
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
            // The places' order (⌥1…7 in the window too; see lib/go.ts).
            &item(app, "go-overview", "Overview", Some("Alt+1"))?,
            &item(app, "go-tasks", "Tasks", Some("Alt+2"))?,
            &item(app, "go-room", "Chat", Some("Alt+3"))?,
            &item(app, "go-search", "Search", Some("Alt+4"))?,
            &item(app, "go-usage", "Usage", Some("Alt+5"))?,
            &item(app, "go-terminal", "Terminal", Some("Alt+6"))?,
            &item(app, "go-files", "Shared Files", Some("Alt+7"))?,
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
            &item(app, "help-welcome", "Welcome to Klaud", None)?,
            &PredefinedMenuItem::separator(app)?,
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
            &item(app, "ws-commit", "Commit…", Some("Shift+CmdOrCtrl+C"))?,
            &item(app, "ws-pr", "Pull Request…", Some("Shift+CmdOrCtrl+P"))?,
            &item(app, "ws-merge", "Merge…", Some("Shift+CmdOrCtrl+M"))?,
            &PredefinedMenuItem::separator(app)?,
            &item(app, "ws-run", "Run", Some("CmdOrCtrl+R"))?,
            &item(
                app,
                "ws-review",
                "Ask Claude to Review…",
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

/// Your status on the klaud network, as the menu-bar menu shows it (see `set_tray_presence`).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TrayPresence {
    /// online, away, dnd or offline (appear offline).
    pub state: String,
    /// "Do Not Disturb until 3:30 PM · in a meeting".
    pub line: String,
}

/// The status items: Online / Away / Do Not Disturb / Appear Offline (yours ticked), pausing
/// notifications for a while, and the window's status sheet for a note.
fn status_items<R: Runtime>(
    app: &AppHandle<R>,
    p: &TrayPresence,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let check = |id: &str, label: &str, state: &str| {
        CheckMenuItem::with_id(app, id, label, true, p.state == state, None::<&str>)
            .map(MenuItemKind::Check)
    };
    let pause = Submenu::with_items(
        app,
        "Pause Notifications",
        true,
        &[
            &item(app, "status-dnd-hour", "For 1 Hour", None)?,
            &item(app, "status-dnd-tomorrow", "Until Tomorrow", None)?,
        ],
    )?;
    Ok(vec![
        MenuItemKind::MenuItem(MenuItem::with_id(
            app,
            "status-line",
            &p.line,
            false,
            None::<&str>,
        )?),
        check("status-online", "Online", "online")?,
        check("status-away", "Away", "away")?,
        check("status-dnd", "Do Not Disturb", "dnd")?,
        check("status-offline", "Appear Offline", "offline")?,
        MenuItemKind::Submenu(pause),
        MenuItemKind::MenuItem(item(app, "status-set", "Set a Status…", None)?),
        MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
    ])
}

/// One request waiting for you: a submenu with Approve / Always Allow / Decline / Review….
fn request_item<R: Runtime>(
    app: &AppHandle<R>,
    r: &crate::requests::TrayRequest,
) -> tauri::Result<Submenu<R>> {
    let mut items: Vec<MenuItem<R>> =
        vec![item(app, &format!("req-yes:{}", r.id), "Approve", None)?];
    if r.always {
        items.push(item(
            app,
            &format!("req-always:{}", r.id),
            "Always Allow for a Week",
            None,
        )?);
    }
    items.push(item(app, &format!("req-no:{}", r.id), "Decline", None)?);
    items.push(item(app, &format!("req-open:{}", r.id), "Review…", None)?);
    let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    Submenu::with_items(app, &r.title, true, &refs)
}

/// The menu-bar menu: requests waiting for you, your status (while you're on the klaud
/// network), open klaud, quit.
pub fn tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    presence: Option<&TrayPresence>,
    requests: &[crate::requests::TrayRequest],
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if !requests.is_empty() {
        let head = if requests.len() == 1 {
            "1 Request Waiting for You".to_string()
        } else {
            format!("{} Requests Waiting for You", requests.len())
        };
        menu.append(&MenuItem::with_id(
            app,
            "req-head",
            head,
            false,
            None::<&str>,
        )?)?;
        for r in requests {
            menu.append(&request_item(app, r)?)?;
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    if let Some(p) = presence {
        for it in status_items(app, p)? {
            menu.append(&it)?;
        }
    }
    menu.append(&item(app, "show", "Open Klaud", None)?)?;
    menu.append(&item(app, "new-chat", "New Chat", None)?)?;
    if presence.is_some() {
        menu.append(&item(app, "add-friend", "Add a Friend…", None)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&item(app, "quit", "Quit Klaud", None)?)?;
    Ok(menu)
}

/// The icon in the menu bar: open klaud, or quit it (leaving the room).
pub fn tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = tray_menu(app, None, &[])?;
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
