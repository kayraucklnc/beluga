//! Friends' requests outside the window: Approve / Always / Decline on the macOS notification,
//! and the requests waiting for you in the menu-bar menu. The window decides what each answer
//! means (it asks Beluga); this side only shows the buttons and says which one was pressed.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_notification::{Action, ActionPerformed, ActionType, NotificationExt};

use crate::menu::{self, TrayPresence};

/// A request waiting for you, as the menu-bar menu lists it (see `set_tray_requests`).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct TrayRequest {
    /// The approval's id (what the window answers).
    pub id: String,
    /// "mia's Claude wants to: review the landing copy".
    pub title: String,
    /// It can be answered with Always (a rule for requests like it).
    pub always: bool,
}

/// What the menu-bar menu shows besides its fixed items: your status and the requests waiting.
#[derive(Debug, Default)]
pub struct TrayModel {
    pub presence: Option<TrayPresence>,
    pub requests: Vec<TrayRequest>,
}

#[derive(Debug, Default)]
pub struct TrayState(pub Mutex<TrayModel>);

/// Build the menu-bar menu again from what it shows now.
pub fn rebuild<R: Runtime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id("beluga") else {
        return;
    };
    let Some(state) = app.try_state::<TrayState>() else {
        return;
    };
    let model = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Ok(m) = menu::tray_menu(app, model.presence.as_ref(), &model.requests) {
        let _ = tray.set_menu(Some(m));
    }
}

/// Your Beluga network status changed (`None`: the network is off).
pub fn set_presence<R: Runtime>(app: &AppHandle<R>, presence: Option<TrayPresence>) {
    if let Some(state) = app.try_state::<TrayState>() {
        state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .presence = presence;
    }
    rebuild(app);
}

/// The requests waiting for you changed (at most a few are listed).
#[tauri::command]
pub fn set_tray_requests(app: AppHandle, requests: Vec<TrayRequest>) {
    if let Some(state) = app.try_state::<TrayState>() {
        let mut model = state
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if model.requests == requests {
            return;
        }
        model.requests = requests.into_iter().take(MAX_LISTED).collect();
    }
    rebuild(&app);
}

/// Requests listed in the menu-bar menu at once (the rest are in the window).
pub const MAX_LISTED: usize = 6;

/// The notification buttons, by action type: (id, title) in order. A friend's request can be
/// answered from the notification ("Always" there lasts a week; the request sheet offers the rest);
/// anything else (your own Claude's tools) is only reviewed in the window. The first button is
/// what a click on "Options" itself reports, so it's the harmless one: Review.
pub fn action_sets() -> Vec<(&'static str, Vec<(&'static str, &'static str)>)> {
    vec![
        (
            "beluga-request",
            vec![
                ("review", "Review…"),
                ("approve", "Approve"),
                ("always", "Always Allow for a Week"),
                ("decline", "Decline"),
            ],
        ),
        ("beluga-review", vec![("review", "Review…")]),
    ]
}

pub fn register_actions<R: Runtime>(app: &AppHandle<R>) -> tauri_plugin_notification::Result<()> {
    let types = action_sets()
        .into_iter()
        .map(|(id, actions)| {
            ActionType::builder(id)
                .actions(
                    actions
                        .into_iter()
                        .map(|(action, title)| {
                            Action::builder(action, title)
                                .destructive(action == "decline")
                                .build()
                        })
                        .collect(),
                )
                .build()
        })
        .collect();
    app.notification().register_action_types(types)
}

/// What a notification's button means for the window, if it's one of the request buttons
/// (a click on the notification itself reviews the request).
pub fn request_action(action_id: &str) -> Option<&'static str> {
    match action_id {
        "review" | "tap" => Some("review"),
        "approve" => Some("approve"),
        "always" => Some("always"),
        "decline" => Some("decline"),
        _ => None,
    }
}

/// A button (or the notification) of an approval was pressed: tell the window. False if the
/// notification wasn't about an approval (the window's usual tap handling goes on).
pub fn on_notification<R: Runtime>(app: &AppHandle<R>, performed: &ActionPerformed) -> bool {
    let extra = performed.notification().map(|n| n.extra());
    let field = |key: &str| {
        extra
            .and_then(|e| e.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
    };
    let Some(approval) = field("approval") else {
        return false;
    };
    let Some(action) = request_action(performed.action_id()) else {
        return false;
    };
    // Reviewing needs the window; answering doesn't.
    if action == "review" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let _ = app.emit(
        "notification-request",
        serde_json::json!({ "action": action, "approval": approval, "task": field("task") }),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::request_action;

    #[test]
    fn only_a_friends_request_can_be_answered_from_a_notification() {
        let sets = super::action_sets();
        let review = &sets
            .iter()
            .find(|(id, _)| *id == "beluga-review")
            .unwrap()
            .1;
        assert_eq!(review, &vec![("review", "Review…")]);
        let request = &sets
            .iter()
            .find(|(id, _)| *id == "beluga-request")
            .unwrap()
            .1;
        assert_eq!(request[0].0, "review");
        assert!(request
            .iter()
            .any(|(id, title)| *id == "always" && title.contains("Week")));
    }

    #[test]
    fn buttons_map_to_answers_and_a_click_reviews() {
        assert_eq!(request_action("approve"), Some("approve"));
        assert_eq!(request_action("always"), Some("always"));
        assert_eq!(request_action("decline"), Some("decline"));
        assert_eq!(request_action("tap"), Some("review"));
        assert_eq!(request_action("review"), Some("review"));
        assert_eq!(request_action("snooze"), None);
    }
}
