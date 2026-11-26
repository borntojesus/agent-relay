//! Shapes of docs/console-api.md that the Rust core reads itself (session,
//! polling, notifications). Everything else passes through to the UI as JSON.
//! Unknown fields are ignored and new optional fields default, so a newer
//! relay does not break an older client.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Owner {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub tz: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenInfo {
    pub label: String,
    pub read: bool,
    pub send: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Channels {
    #[serde(default)]
    pub telegram: bool,
    #[serde(default)]
    pub console: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
}

/// GET /owner/me
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Me {
    pub owner: Owner,
    pub token: TokenInfo,
    #[serde(default)]
    pub channels: Channels,
    #[serde(default)]
    pub version: String,
    /// 0.4.0; absent on older relays.
    #[serde(default)]
    pub teams: Vec<TeamRef>,
}

/// GET /owner/summary
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub unread: i64,
    pub unread_own: i64,
    pub pending_posts: i64,
    pub pending_approvals: i64,
    pub feed_cursor: i64,
    pub audit_cursor: i64,
}

/// ConsoleMessage, plus the optional fields of the pending/thread variants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleMessage {
    pub id: i64,
    pub ver: i64,
    pub room: String,
    pub thread: String,
    pub from: String,
    pub owner: String,
    #[serde(default)]
    pub owner_name: String,
    pub mine: bool,
    pub sent_at: String,
    pub text: String,
    pub status: String,
    #[serde(default)]
    pub gated: bool,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub read: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seen_by: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApprovalEffect {
    #[serde(default)]
    pub diff: Option<String>,
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default)]
    pub amount: Option<String>,
    #[serde(default)]
    pub details: Option<String>,
}

/// OwnerApproval
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub project: String,
    pub action: String,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub effect: ApprovalEffect,
    #[serde(default)]
    pub requester: String,
    pub status: String,
    #[serde(default)]
    pub decided_via: Option<String>,
    #[serde(default)]
    pub decided_by: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub decided_at: Option<String>,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub caller: String,
}

/// GET /owner/pending
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Pending {
    #[serde(default)]
    pub posts: Vec<ConsoleMessage>,
    #[serde(default)]
    pub approvals: Vec<Approval>,
}

/// GET /owner/feed
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeedPage {
    pub messages: Vec<ConsoleMessage>,
    pub cursor: i64,
    #[serde(default)]
    pub more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_me_without_teams() {
        let me: Me = serde_json::from_str(
            r#"{"owner":{"id":"alice","name":"Alice","tz":"UTC"},"token":{"label":"alice-console","read":true,"send":true},"channels":{"telegram":false,"console":true},"version":"0.3.0"}"#,
        )
        .unwrap();
        assert_eq!(me.owner.id, "alice");
        assert!(me.teams.is_empty());
    }

    #[test]
    fn decodes_pending() {
        let p: Pending = serde_json::from_str(
            r#"{"posts":[{"id":1,"ver":2,"room":"shared","thread":"main","from":"alice-mac","owner":"alice","ownerName":"Alice","mine":true,"sentAt":"2026-01-01T00:00:00.000Z","text":"hi","status":"pending","gated":true,"decidedAt":null,"decidedBy":null,"read":false,"seenBy":["Bob"],"expiresAt":"2026-01-02T00:00:00.000Z"}],
               "approvals":[{"id":"a1","scope":"web-app","project":"web-app","action":"deploy","tier":"big","summary":"ship","effect":{"diff":null},"requester":"alice-mac","status":"pending","decidedVia":null,"decidedBy":null,"createdAt":"x","expiresAt":"y","decidedAt":null,"ref":null,"caller":"alice-mac"}]}"#,
        )
        .unwrap();
        assert_eq!(p.posts[0].seen_by.as_deref(), Some(&["Bob".to_string()][..]));
        assert_eq!(p.approvals[0].action, "deploy");
    }
}
