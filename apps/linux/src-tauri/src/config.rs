//! Plain settings file (`~/.config/org.antonyuk.agent-relay/settings.json`):
//! server URL, username and UI preferences. Never the token.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server: String,
    pub owner: String,
    /// Seconds between summary polls while online (backs off to 30 on errors).
    pub poll_seconds: u64,
    pub notifications: bool,
    pub tray: bool,
    /// Last selected team in the Team view.
    pub team: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server: "https://relay.example.org".into(),
            owner: String::new(),
            poll_seconds: 5,
            notifications: true,
            tray: true,
            team: String::new(),
        }
    }
}

impl Settings {
    pub fn sanitized(mut self) -> Self {
        self.poll_seconds = self.poll_seconds.clamp(2, 60);
        self
    }
}

pub fn load(path: &PathBuf) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .unwrap_or_default()
        .sanitized()
}

pub fn save(path: &PathBuf, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}
