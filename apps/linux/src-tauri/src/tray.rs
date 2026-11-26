//! Optional tray item (StatusNotifierItem through libayatana-appindicator).
//! On GNOME it shows only with the AppIndicator extension, which Ubuntu ships
//! enabled. Linux tray items get no click events, so everything is in the menu.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const ID: &str = "main";

#[derive(Default)]
pub struct TrayState {
    status: Mutex<Option<MenuItem<Wry>>>,
}

pub fn sync(app: &AppHandle, enabled: bool, line: &str) {
    let st = app.state::<TrayState>();
    if !enabled {
        if app.remove_tray_by_id(ID).is_some() {
            *st.status.lock().unwrap() = None;
        }
        return;
    }
    if let Some(item) = st.status.lock().unwrap().as_ref() {
        let _ = item.set_text(line);
        return;
    }
    let build = || -> tauri::Result<MenuItem<Wry>> {
        let status = MenuItem::with_id(app, "status", line, false, None::<&str>)?;
        let open = MenuItem::with_id(app, "open", "Open Agent Relay", true, None::<&str>)?;
        let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&status, &sep, &open, &refresh, &quit])?;
        let mut b = TrayIconBuilder::with_id(ID).menu(&menu).tooltip("Agent Relay").on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => crate::show_main(app),
            "refresh" => crate::wake(app),
            "quit" => app.exit(0),
            _ => {}
        });
        if let Some(icon) = app.default_window_icon() {
            b = b.icon(icon.clone());
        }
        b.build(app)?;
        Ok(status)
    };
    match build() {
        Ok(item) => *st.status.lock().unwrap() = Some(item),
        Err(e) => eprintln!("tray not available: {e}"),
    }
}
