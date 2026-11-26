//! Token storage in the system secret store: Secret Service (GNOME Keyring,
//! KWallet) on Linux, the login Keychain on macOS. Service
//! `org.antonyuk.agent-relay`, account `<username>@<host>`. Never a file.
//!
//! Every call runs on its own OS thread: the Secret Service backend drives an
//! async D-Bus connection and must not block inside the Tauri tokio runtime.

#[cfg(target_os = "linux")]
pub const SERVICE: &str = "org.antonyuk.agent-relay";
/// macOS/Windows builds of this client are for development only; keep their
/// items apart from the native Mac app, which uses the service above.
#[cfg(not(target_os = "linux"))]
pub const SERVICE: &str = "org.antonyuk.agent-relay.linux-dev";

fn off_runtime<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::spawn(f).join().expect("keyring thread")
}

fn describe(e: keyring::Error) -> String {
    match e {
        keyring::Error::NoStorageAccess(inner) => format!("the keyring is locked or not available ({inner})"),
        keyring::Error::PlatformFailure(inner) => format!("the keyring failed ({inner})"),
        other => other.to_string(),
    }
}

pub fn save(account: &str, token: &str) -> Result<(), String> {
    let (account, token) = (account.to_string(), token.to_string());
    off_runtime(move || {
        let entry = keyring::Entry::new(SERVICE, &account).map_err(describe)?;
        entry.set_password(&token).map_err(describe)
    })
}

/// Ok(None) when there is no item; Err when the store itself is unusable.
pub fn load(account: &str) -> Result<Option<String>, String> {
    let account = account.to_string();
    off_runtime(move || {
        let entry = keyring::Entry::new(SERVICE, &account).map_err(describe)?;
        match entry.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(describe(e)),
        }
    })
}

pub fn delete(account: &str) -> Result<(), String> {
    let account = account.to_string();
    off_runtime(move || {
        let entry = keyring::Entry::new(SERVICE, &account).map_err(describe)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(describe(e)),
        }
    })
}
