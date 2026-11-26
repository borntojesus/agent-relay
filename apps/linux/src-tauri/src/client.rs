//! Owner console API client (docs/console-api.md). Holds the bearer in memory
//! only and never logs it. The webview never sees the token: it asks the core
//! through Tauri commands and gets JSON back.

use std::time::Duration;

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::models::{FeedPage, Me, Pending, Summary};

/// Path segment encoding: everything except unreserved characters.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ').add(b'"').add(b'#').add(b'%').add(b'/').add(b'<').add(b'>').add(b'?')
    .add(b'`').add(b'{').add(b'}').add(b'\\').add(b'^').add(b'|').add(b'[').add(b']')
    .add(b'@').add(b':').add(b'&').add(b'=').add(b'+').add(b'$').add(b',').add(b';');

pub fn seg(s: &str) -> String {
    utf8_percent_encode(s, SEGMENT).to_string()
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    /// HTTP status, 0 for transport errors.
    pub status: u16,
    pub message: String,
}

impl ApiError {
    fn transport(e: impl std::fmt::Display) -> Self {
        ApiError { status: 0, message: format!("Cannot reach the server: {e}") }
    }
    pub fn other(m: impl Into<String>) -> Self {
        ApiError { status: 0, message: m.into() }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            0 => write!(f, "{}", self.message),
            401 => write!(f, "Unauthorized: wrong username or token ({}).", self.message),
            403 => write!(f, "Forbidden: {}", self.message),
            404 => write!(f, "Not found: {}", self.message),
            409 => write!(f, "Already decided: {}", self.message),
            s => write!(f, "HTTP {s}: {}", self.message),
        }
    }
}

#[derive(Clone)]
pub struct Client {
    pub base: Url,
    pub owner: String,
    token: String,
    http: reqwest::Client,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base.as_str()).field("owner", &self.owner).finish_non_exhaustive()
    }
}

/// Accepts "relay.example.org" or a full URL; strips trailing slashes.
pub fn normalize(server: &str) -> Option<Url> {
    let mut s = server.trim().to_string();
    if s.is_empty() {
        return None;
    }
    if !s.contains("://") {
        s = format!("https://{s}");
    }
    while s.ends_with('/') {
        s.pop();
    }
    let u = Url::parse(&s).ok()?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return None;
    }
    Some(u)
}

/// Keyring account: `<owner>@<host[:port]>`, same as the Mac app.
pub fn account(owner: &str, base: &Url) -> String {
    let mut host = base.host_str().unwrap_or_default().to_string();
    if let Some(p) = base.port() {
        host.push_str(&format!(":{p}"));
    }
    format!("{owner}@{host}")
}

impl Client {
    pub fn new(base: Url, owner: String, token: String) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("agent-relay-linux/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Client { base, owner, token, http }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// `path` is already percent-encoded per segment and starts with `/owner/`.
    pub async fn call(&self, method: &str, path: &str, query: &[(String, String)], body: Option<&Value>) -> Result<Value, ApiError> {
        let method = Method::from_bytes(method.as_bytes()).map_err(|_| ApiError::other("bad method"))?;
        let base = self.base.as_str().trim_end_matches('/');
        let mut url = Url::parse(&format!("{base}{path}")).map_err(|_| ApiError::other("The server URL is not valid."))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        }
        let mut req = self
            .http
            .request(method, url)
            .bearer_auth(&self.token)
            .header("X-Relay-Owner", &self.owner)
            .header("Accept", "application/json")
            .header("Cache-Control", "no-cache");
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| ApiError::transport(e.without_url()))?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(|e| ApiError::transport(e.without_url()))?;
        if !status.is_success() {
            let msg = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
                .unwrap_or_else(|| status.canonical_reason().unwrap_or("error").to_string());
            return Err(ApiError { status: status.as_u16(), message: msg });
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| ApiError::other(format!("Unexpected response from the server: {e}")))
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(String, String)]) -> Result<T, ApiError> {
        let v = self.call("GET", path, query, None).await?;
        serde_json::from_value(v).map_err(|e| ApiError::other(format!("Unexpected response from the server: {e}")))
    }

    pub async fn me(&self) -> Result<Me, ApiError> {
        self.get("/owner/me", &[]).await
    }
    pub async fn summary(&self) -> Result<Summary, ApiError> {
        self.get("/owner/summary", &[]).await
    }
    pub async fn pending(&self) -> Result<Pending, ApiError> {
        self.get("/owner/pending", &[]).await
    }
    pub async fn feed(&self, after: i64, limit: u32) -> Result<FeedPage, ApiError> {
        self.get("/owner/feed", &[("after".into(), after.to_string()), ("limit".into(), limit.to_string())]).await
    }
    pub async fn decide_post(&self, id: i64, decision: &str) -> Result<Value, ApiError> {
        self.call("POST", &format!("/owner/posts/{id}/decide"), &[], Some(&serde_json::json!({ "decision": decision }))).await
    }
    pub async fn decide_approval(&self, id: &str, decision: &str) -> Result<Value, ApiError> {
        self.call("POST", &format!("/owner/approvals/{}/decide", seg(id)), &[], Some(&serde_json::json!({ "decision": decision })))
            .await
    }
}

/// The UI may only reach the console routes, never another path on the host.
pub fn allowed_path(path: &str) -> bool {
    path.starts_with("/owner/")
        && !path.contains("..")
        && !path.contains("//")
        && !path.contains('?')
        && !path.contains('#')
        && path.chars().all(|c| c.is_ascii_graphic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize("relay.example.org/").unwrap().as_str(), "https://relay.example.org/");
        assert_eq!(normalize("http://127.0.0.1:4960").unwrap().port(), Some(4960));
        assert!(normalize("ftp://x").is_none());
        assert!(normalize("  ").is_none());
    }

    #[test]
    fn account_has_port() {
        let u = normalize("http://127.0.0.1:4960").unwrap();
        assert_eq!(account("alice", &u), "alice@127.0.0.1:4960");
    }

    #[test]
    fn paths() {
        assert!(allowed_path("/owner/rooms/web-app/threads"));
        assert!(allowed_path("/owner/teams/team/members/bob"));
        assert!(!allowed_path("/admin"));
        assert!(!allowed_path("/owner/../x"));
        assert!(!allowed_path("/owner/a b"));
        assert_eq!(seg("a/b c"), "a%2Fb%20c");
    }

    /// Contract check against a running throwaway relay. Run with
    /// RELAY_TEST_URL, RELAY_TEST_OWNER, RELAY_TEST_TOKEN set and
    /// `cargo test -- --ignored live_relay`; RELAY_TEST_DECIDE=1 also sends
    /// the first held post and rejects the first approval.
    #[tokio::test]
    #[ignore]
    async fn live_relay() {
        let var = |k: &str| std::env::var(k).expect(k);
        let owner = var("RELAY_TEST_OWNER");
        let c = Client::new(normalize(&var("RELAY_TEST_URL")).unwrap(), owner.clone(), var("RELAY_TEST_TOKEN"));
        let me = c.me().await.expect("me");
        assert_eq!(me.owner.id, owner);
        let s = c.summary().await.expect("summary");
        let p = c.pending().await.expect("pending");
        let f = c.feed(0, 200).await.expect("feed");
        eprintln!("summary={s:?} posts={} approvals={} feed={}", p.posts.len(), p.approvals.len(), f.messages.len());
        for path in ["/owner/rooms", "/owner/teams", "/owner/tokens", "/owner/audit"] {
            c.call("GET", path, &[], None).await.unwrap_or_else(|e| panic!("{path}: {}", e.message));
        }
        let bad = Client::new(normalize(&var("RELAY_TEST_URL")).unwrap(), owner, "wrong".into());
        assert_eq!(bad.me().await.unwrap_err().status, 401);
        if std::env::var("RELAY_TEST_DECIDE").is_ok() {
            if let Some(post) = p.posts.first() {
                eprintln!("post: {:?}", c.decide_post(post.id, "approve").await.expect("decide post"));
            }
            if let Some(a) = p.approvals.first() {
                eprintln!("approval: {:?}", c.decide_approval(&a.id, "reject").await.expect("decide approval"));
            }
            let after = c.summary().await.expect("summary");
            assert!(after.pending_posts + after.pending_approvals < s.pending_posts + s.pending_approvals);
        }
    }

}
