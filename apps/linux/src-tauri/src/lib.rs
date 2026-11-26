//! Agent Relay desktop core: session, keyring, polling, notifications, tray.
//! The webview gets state through the `relay://state` event and calls the
//! commands below; it never sees the console token.

// Notification actions (and their helpers) are wired on Linux only.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

mod client;
mod config;
mod models;
mod notify;
mod secret;
mod tray;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tokio::sync::Notify;

use client::{ApiError, Client};
use config::Settings;
use models::{ConsoleMessage, Me, Pending, Summary};
use notify::{Note, Target};

const FEED_KEEP: usize = 500;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    online: bool,
    last_error: Option<String>,
    last_sync: Option<u64>,
    summary: Summary,
    pending: Pending,
    /// Newest first.
    feed: Vec<ConsoleMessage>,
}

#[derive(Default)]
struct Inner {
    client: Option<Client>,
    me: Option<Me>,
    settings: Settings,
    /// Bumped on every sign-in / sign-out; a poll loop of an old generation stops.
    generation: u64,
    session_only: bool,
    sign_in_message: Option<String>,
    snap: Snapshot,
    primed: bool,
    feed_cursor: i64,
    known_posts: HashSet<i64>,
    known_approvals: HashSet<String>,
    ticks: u64,
    window_visible: bool,
}

pub struct Core {
    inner: Mutex<Inner>,
    wake: Notify,
    settings_path: PathBuf,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Core {
    fn view(&self) -> Value {
        let i = self.inner.lock().unwrap();
        json!({
            "signedIn": i.client.is_some() && i.me.is_some(),
            "connecting": i.client.is_some() && i.me.is_none(),
            "me": i.me,
            "server": i.client.as_ref().map(|c| c.base.as_str().trim_end_matches('/').to_string()).unwrap_or_else(|| i.settings.server.clone()),
            "settings": i.settings,
            "signInMessage": i.sign_in_message,
            "sessionOnly": i.session_only,
            "snapshot": i.snap,
            "version": env!("CARGO_PKG_VERSION"),
        })
    }

    fn client(&self) -> Option<Client> {
        self.inner.lock().unwrap().client.clone()
    }

    fn can_send(&self) -> bool {
        self.inner.lock().unwrap().me.as_ref().map(|m| m.token.send).unwrap_or(false)
    }
}

fn core(app: &AppHandle) -> Arc<Core> {
    app.state::<Arc<Core>>().inner().clone()
}

fn emit_state(app: &AppHandle) {
    let c = core(app);
    let _ = app.emit("relay://state", c.view());
    update_badges(app);
}

fn update_badges(app: &AppHandle) {
    let c = core(app);
    let (signed_in, n, tray_on, owner) = {
        let i = c.inner.lock().unwrap();
        let s = i.snap.summary;
        (i.me.is_some(), s.pending_posts + s.pending_approvals, i.settings.tray, i.me.as_ref().map(|m| m.owner.id.clone()))
    };
    if let Some(w) = app.get_webview_window("main") {
        let title = if signed_in && n > 0 { format!("Agent Relay ({n})") } else { "Agent Relay".to_string() };
        let _ = w.set_title(&title);
        // Unity launcher API on Linux (Ubuntu Dock), Dock badge on macOS.
        let _ = w.set_badge_count(if signed_in && n > 0 { Some(n) } else { None });
    }
    let line = match (signed_in, owner) {
        (true, Some(o)) if n > 0 => format!("{o}: {n} waiting"),
        (true, Some(o)) => format!("{o}: nothing waits"),
        _ => "Signed out".to_string(),
    };
    tray::sync(app, tray_on, &line);
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        core(app).inner.lock().unwrap().window_visible = true;
    }
}

pub(crate) fn wake(app: &AppHandle) {
    core(app).wake.notify_one();
}

pub(crate) fn open_target(app: &AppHandle, target: &Target) {
    show_main(app);
    let _ = app.emit("relay://open", target);
}

pub(crate) fn on_notification_decision(app: &AppHandle, target: &Target, action: &str) {
    let app = app.clone();
    let target = target.clone();
    let decision = if action == "approve" { "approve" } else { "reject" }.to_string();
    tauri::async_runtime::spawn(async move {
        let c = core(&app);
        let Some(cl) = c.client() else { return };
        if !c.can_send() {
            return;
        }
        let r = match &target {
            Target::Post { id, .. } => cl.decide_post(*id, &decision).await,
            Target::Approval { id } => cl.decide_approval(id, &decision).await,
            Target::Message { .. } => return,
        };
        if let Err(e) = r {
            let _ = app.emit("relay://error", e.to_string());
            open_target(&app, &target);
        }
        c.wake.notify_one();
    });
}

// ---------------------------------------------------------------- session

fn begin_polling(app: &AppHandle) {
    let c = core(app);
    let generation = c.inner.lock().unwrap().generation;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut delay = 5u64;
        loop {
            let c = core(&app);
            let (cur, base) = {
                let i = c.inner.lock().unwrap();
                (i.generation, i.settings.poll_seconds)
            };
            if cur != generation {
                return;
            }
            let ok = tick(&app, generation).await;
            delay = if ok { base } else { (delay * 2).clamp(10, 30) };
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
                _ = c.wake.notified() => {}
            }
        }
    });
}

async fn tick(app: &AppHandle, generation: u64) -> bool {
    let c = core(app);
    let Some(cl) = c.client() else { return false };
    match tick_inner(app, &c, &cl, generation).await {
        Ok(()) => true,
        Err(e) if e.status == 401 => {
            if c.inner.lock().unwrap().generation == generation {
                sign_out_inner(app, Some("The token was rejected (revoked or wrong). Sign in again.".into()));
            }
            false
        }
        Err(e) => {
            {
                let mut i = c.inner.lock().unwrap();
                if i.generation != generation {
                    return false;
                }
                i.snap.online = false;
                i.snap.last_error = Some(e.to_string());
            }
            emit_state(app);
            false
        }
    }
}

async fn tick_inner(app: &AppHandle, c: &Arc<Core>, cl: &Client, generation: u64) -> Result<(), ApiError> {
    // Restored offline: confirm the session first.
    if c.inner.lock().unwrap().me.is_none() {
        let me = cl.me().await?;
        c.inner.lock().unwrap().me = Some(me);
    }
    let s = cl.summary().await?;
    let (primed, old, feed_cursor, ticks, notify_on, can_send) = {
        let mut i = c.inner.lock().unwrap();
        i.ticks += 1;
        (i.primed, i.snap.summary, i.feed_cursor, i.ticks, i.settings.notifications, i.me.as_ref().map(|m| m.token.send).unwrap_or(false))
    };
    let feed_moved = s.feed_cursor != feed_cursor;
    let mut notes: Vec<Note> = Vec::new();

    let mut fresh: Vec<ConsoleMessage> = Vec::new();
    let mut after = feed_cursor;
    if !primed || feed_moved {
        after = if primed { feed_cursor } else { (s.feed_cursor - 200).max(0) };
        for _ in 0..5 {
            let page = cl.feed(after, 200).await?;
            fresh.extend(page.messages);
            after = page.cursor;
            if !page.more {
                break;
            }
        }
    }
    let pending = if !primed || feed_moved || ticks % 6 == 0 || s.pending_posts != old.pending_posts || s.pending_approvals != old.pending_approvals {
        Some(cl.pending().await?)
    } else {
        None
    };

    {
        let mut i = c.inner.lock().unwrap();
        if i.generation != generation {
            return Ok(());
        }
        if !fresh.is_empty() {
            let mut by_id: HashMap<i64, ConsoleMessage> = i.snap.feed.drain(..).map(|m| (m.id, m)).collect();
            for m in fresh {
                let prev = by_id.get(&m.id);
                if prev.map(|p| p.ver).unwrap_or(-1) >= m.ver {
                    continue;
                }
                let was_delivered = prev.map(|p| p.status == "delivered").unwrap_or(false);
                if primed && !m.mine && m.status == "delivered" && !m.read && !was_delivered {
                    notes.push(Note {
                        title: format!("{} / {}", m.room, m.thread),
                        body: format!("{} ({}): {}", m.owner_name, m.from, notify::clip(&m.text, 120)),
                        target: Target::Message { room: m.room.clone(), thread: m.thread.clone() },
                        actions: false,
                    });
                }
                by_id.insert(m.id, m);
            }
            let mut feed: Vec<ConsoleMessage> = by_id.into_values().collect();
            feed.sort_by(|a, b| b.ver.cmp(&a.ver));
            feed.truncate(FEED_KEEP);
            i.snap.feed = feed;
        }
        i.feed_cursor = after.max(s.feed_cursor);
        if let Some(p) = pending {
            if primed {
                for post in p.posts.iter().filter(|p| !i.known_posts.contains(&p.id)) {
                    notes.push(Note {
                        title: format!("Held post: {} / {}", post.room, post.thread),
                        body: format!("{}: {}", post.from, notify::clip(&post.text, 120)),
                        target: Target::Post { id: post.id, room: post.room.clone(), thread: post.thread.clone() },
                        actions: can_send,
                    });
                }
                for a in p.approvals.iter().filter(|a| !i.known_approvals.contains(&a.id)) {
                    notes.push(Note {
                        title: format!("Approve {}? ({})", a.action, a.project),
                        body: format!("{}: {}", a.requester, notify::clip(&a.summary, 120)),
                        target: Target::Approval { id: a.id.clone() },
                        actions: can_send,
                    });
                }
            }
            let posts: Vec<i64> = p.posts.iter().map(|p| p.id).collect();
            let approvals: Vec<String> = p.approvals.iter().map(|a| a.id.clone()).collect();
            i.known_posts.extend(posts);
            i.known_approvals.extend(approvals);
            i.snap.pending = p;
        }
        i.snap.summary = s;
        i.snap.online = true;
        i.snap.last_error = None;
        i.snap.last_sync = Some(now_ms());
        i.primed = true;
    }
    if notify_on {
        for n in notes {
            notify::show(app, n);
        }
    }
    emit_state(app);
    Ok(())
}

fn reset_data(i: &mut Inner) {
    i.snap = Snapshot { online: true, ..Default::default() };
    i.primed = false;
    i.feed_cursor = 0;
    i.known_posts.clear();
    i.known_approvals.clear();
    i.ticks = 0;
}

fn sign_out_inner(app: &AppHandle, message: Option<String>) {
    let c = core(app);
    let client = {
        let mut i = c.inner.lock().unwrap();
        i.generation += 1;
        let cl = i.client.take();
        i.me = None;
        i.session_only = false;
        i.sign_in_message = message;
        reset_data(&mut i);
        cl
    };
    if let Some(cl) = client {
        if let Err(e) = secret::delete(&client::account(&cl.owner, &cl.base)) {
            eprintln!("could not delete the keyring item: {e}");
        }
    }
    c.wake.notify_one();
    emit_state(app);
}

fn restore(app: &AppHandle) {
    let c = core(app);
    let (server, owner) = {
        let i = c.inner.lock().unwrap();
        (i.settings.server.clone(), i.settings.owner.clone())
    };
    let Some(base) = client::normalize(&server) else { return };
    if owner.is_empty() {
        return;
    }
    match secret::load(&client::account(&owner, &base)) {
        Ok(Some(token)) => {
            {
                let mut i = c.inner.lock().unwrap();
                i.generation += 1;
                i.client = Some(Client::new(base, owner, token));
                reset_data(&mut i);
            }
            begin_polling(app);
        }
        Ok(None) => {}
        Err(e) => {
            c.inner.lock().unwrap().sign_in_message = Some(format!("Could not read the saved token: {e}. Unlock the keyring or sign in again."));
        }
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn get_state(core: tauri::State<'_, Arc<Core>>) -> Value {
    core.view()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInError {
    message: String,
    /// The pair is valid but the keyring refused the token.
    keyring: bool,
}

impl From<String> for SignInError {
    fn from(message: String) -> Self {
        SignInError { message, keyring: false }
    }
}

#[tauri::command]
async fn sign_in(app: AppHandle, server: String, username: String, token: String, session_only: Option<bool>) -> Result<Value, SignInError> {
    let user = username.trim().to_string();
    let tok = token.trim().to_string();
    if user.contains('@') {
        return Err("Use the username (owner id), not an email.".to_string().into());
    }
    if user.is_empty() {
        return Err("Enter the username.".to_string().into());
    }
    if tok.is_empty() {
        return Err("Enter the token.".to_string().into());
    }
    let base = client::normalize(&server).ok_or_else(|| "The server URL is not valid.".to_string())?;
    let cl = Client::new(base.clone(), user.clone(), tok);
    let me = cl.me().await.map_err(|e| e.to_string())?;
    let session_only = session_only.unwrap_or(false);
    if !session_only {
        if let Err(e) = secret::save(&client::account(&user, &base), cl.token()) {
            return Err(SignInError { message: format!("Signed in, but could not save the token: {e}."), keyring: true });
        }
    }
    let c = core(&app);
    {
        let mut i = c.inner.lock().unwrap();
        i.generation += 1;
        i.settings.server = base.as_str().trim_end_matches('/').to_string();
        i.settings.owner = user;
        i.client = Some(cl);
        i.me = Some(me);
        i.session_only = session_only;
        i.sign_in_message = None;
        reset_data(&mut i);
        let _ = config::save(&c.settings_path, &i.settings);
    }
    begin_polling(&app);
    emit_state(&app);
    Ok(c.view())
}

#[tauri::command]
fn sign_out(app: AppHandle) {
    sign_out_inner(&app, None);
}

#[tauri::command]
async fn api(app: AppHandle, method: String, path: String, query: Option<Vec<(String, String)>>, body: Option<Value>) -> Result<Value, ApiError> {
    let method = method.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PATCH" | "DELETE") || !client::allowed_path(&path) {
        return Err(ApiError::other("route not allowed"));
    }
    let c = core(&app);
    let cl = c.client().ok_or_else(|| ApiError { status: 401, message: "signed out".into() })?;
    let r = cl.call(&method, &path, &query.unwrap_or_default(), body.as_ref()).await;
    match &r {
        Err(e) if e.status == 401 => sign_out_inner(&app, Some("The token was rejected (revoked or wrong). Sign in again.".into())),
        Ok(_) if method != "GET" => c.wake.notify_one(),
        _ => {}
    }
    r
}

#[tauri::command]
fn refresh(core: tauri::State<'_, Arc<Core>>) {
    core.wake.notify_one();
}

#[tauri::command]
fn save_settings(app: AppHandle, poll_seconds: u64, notifications: bool, tray: bool, team: String) -> Result<Value, String> {
    let c = core(&app);
    {
        let mut i = c.inner.lock().unwrap();
        i.settings.poll_seconds = poll_seconds;
        i.settings.notifications = notifications;
        i.settings.tray = tray;
        i.settings.team = team;
        i.settings = i.settings.clone().sanitized();
        config::save(&c.settings_path, &i.settings)?;
    }
    c.wake.notify_one();
    emit_state(&app);
    Ok(c.view())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

pub fn run() {
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // A second launch (app grid, AppImage) brings the running one forward.
        show_main(app);
    }));
    #[cfg(not(target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_notification::init());
    }
    builder = builder
        .manage(tray::TrayState::default())
        .setup(|app| {
            let path = app.path().app_config_dir().expect("config dir").join("settings.json");
            let settings = config::load(&path);
            app.manage(Arc::new(Core {
                inner: Mutex::new(Inner { settings, window_visible: true, snap: Snapshot { online: true, ..Default::default() }, ..Default::default() }),
                wake: Notify::new(),
                settings_path: path,
            }));
            let handle = app.handle().clone();
            restore(&handle);
            update_badges(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app polling; quit from the tray or Ctrl+Q.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                core(window.app_handle()).inner.lock().unwrap().window_visible = false;
            }
        })
        .invoke_handler(tauri::generate_handler![get_state, sign_in, sign_out, api, refresh, save_settings, quit]);
    builder.run(tauri::generate_context!()).expect("error while running Agent Relay");
}
