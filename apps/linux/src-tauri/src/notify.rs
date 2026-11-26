//! Desktop notifications for new held posts, approvals and messages.
//!
//! Linux: `notify-rust` straight to the freedesktop notification server, with
//! Send / Approve / Reject / Open action buttons; a worker thread waits for the
//! click and calls back into the core. `tauri-plugin-notification` is not used
//! on Linux because its desktop backend shows plain banners (action types are a
//! mobile feature). macOS / Windows dev builds use the plugin, without actions.

use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Post { id: i64, room: String, thread: String },
    Approval { id: String },
    Message { room: String, thread: String },
}

#[derive(Debug, Clone)]
pub struct Note {
    pub title: String,
    pub body: String,
    pub target: Target,
    /// Show decision buttons (the token can send).
    pub actions: bool,
}

pub fn clip(s: &str, n: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= n {
        flat
    } else {
        flat.chars().take(n).collect::<String>() + "…"
    }
}

/// GNOME Shell renders a small markup subset in the body (b, i, a href). Agent
/// text is untrusted, so it is escaped and shows verbatim.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(target_os = "linux")]
pub fn show(app: &AppHandle, note: Note) {
    use notify_rust::{Notification, Timeout};

    let app = app.clone();
    std::thread::spawn(move || {
        let mut n = Notification::new();
        n.appname("Agent Relay")
            .summary(&note.title)
            .body(&escape(&note.body))
            .icon("agent-relay")
            .timeout(Timeout::Default)
            .action("default", "Open");
        if note.actions {
            match note.target {
                Target::Post { .. } => {
                    n.action("approve", "Send").action("reject", "Reject");
                }
                Target::Approval { .. } => {
                    n.action("approve", "Approve").action("reject", "Reject");
                }
                Target::Message { .. } => {}
            }
        }
        let handle = match n.show() {
            Ok(h) => h,
            Err(e) => {
                eprintln!("notification failed: {e}");
                return;
            }
        };
        let target = note.target.clone();
        handle.wait_for_action(move |action| match action {
            "approve" | "reject" => crate::on_notification_decision(&app, &target, action),
            "default" => crate::open_target(&app, &target),
            _ => {} // "__closed": dismissed or expired
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn show(app: &AppHandle, note: Note) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(&note.title).body(&note.body).show();
}
