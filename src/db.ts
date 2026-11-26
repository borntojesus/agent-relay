import { DatabaseSync } from "node:sqlite";

/**
 * Opens the relay database: one SQLite file for owners, tokens, rooms,
 * messages, read marks, action approvals and the audit log. `:memory:` in
 * tests. WAL plus a busy timeout so a second connection (the admin CLI next
 * to a running server) waits instead of failing.
 */
export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch {
      // Another connection may hold a lock while switching; WAL is persistent per file.
    }
    db.exec("PRAGMA synchronous = NORMAL");
  }
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      telegram_user TEXT,
      tz            TEXT NOT NULL DEFAULT 'UTC',
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL UNIQUE,
      owner       TEXT NOT NULL REFERENCES owners(id),
      hash        TEXT NOT NULL UNIQUE,
      grants      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS teams (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      gate       TEXT NOT NULL DEFAULT 'on' CHECK (gate IN ('on', 'off')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team     TEXT NOT NULL REFERENCES teams(id),
      owner    TEXT NOT NULL REFERENCES owners(id),
      role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
      added_at TEXT NOT NULL,
      PRIMARY KEY (team, owner)
    );
    CREATE INDEX IF NOT EXISTS team_members_owner ON team_members (owner, team);
    CREATE TABLE IF NOT EXISTS team_invites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      team       TEXT NOT NULL REFERENCES teams(id),
      name       TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (team, name)
    );
    CREATE TABLE IF NOT EXISTS rooms (
      name       TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      room         TEXT NOT NULL REFERENCES rooms(name),
      thread       TEXT NOT NULL,
      sender_token INTEGER NOT NULL,
      sender_label TEXT NOT NULL,
      sender_owner TEXT NOT NULL,
      sent_at      TEXT NOT NULL,
      text         TEXT NOT NULL,
      status       TEXT NOT NULL,
      gated        INTEGER NOT NULL,
      nonce        TEXT NOT NULL,
      card_id      INTEGER,
      decided_at   TEXT,
      decided_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages (room, thread, id);
    CREATE INDEX IF NOT EXISTS messages_status ON messages (status, sent_at);
    CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender_token, sent_at);
    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL REFERENCES messages(id),
      token_id   INTEGER NOT NULL,
      read_at    TEXT NOT NULL,
      PRIMARY KEY (message_id, token_id)
    );
    CREATE INDEX IF NOT EXISTS message_reads_token ON message_reads (token_id, message_id);
    CREATE TABLE IF NOT EXISTS action_approvals (
      id            TEXT PRIMARY KEY,
      nonce         TEXT NOT NULL,
      scope         TEXT NOT NULL,
      owner         TEXT NOT NULL,
      caller_key    TEXT NOT NULL,
      caller_label  TEXT NOT NULL,
      project       TEXT NOT NULL,
      action        TEXT NOT NULL,
      tier          TEXT NOT NULL,
      declared_risk TEXT,
      client        INTEGER NOT NULL,
      summary       TEXT NOT NULL,
      effect        TEXT NOT NULL,
      requester     TEXT NOT NULL,
      ref           TEXT,
      status        TEXT NOT NULL,
      decided_via   TEXT,
      decided_by    TEXT,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      decided_at    TEXT,
      message_id    INTEGER
    );
    CREATE INDEX IF NOT EXISTS action_approvals_caller ON action_approvals (caller_key, created_at);
    CREATE INDEX IF NOT EXISTS action_approvals_pending ON action_approvals (status, expires_at);
    CREATE TABLE IF NOT EXISTS audit (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      TEXT NOT NULL,
      actor   TEXT NOT NULL,
      owner   TEXT,
      action  TEXT NOT NULL,
      target  TEXT,
      ok      INTEGER NOT NULL,
      detail  TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
    CREATE INDEX IF NOT EXISTS audit_owner ON audit (owner, id);
  `);
  // Columns added after 0.1.0. ALTER only when missing, so this stays idempotent.
  addColumn(db, "tokens", "last_used_at", "TEXT");
  addColumn(db, "messages", "ver", "INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS messages_ver ON messages (ver)");
  // 0.4.0: a room belongs to at most one team; NULL = a personal/direct room.
  addColumn(db, "rooms", "team", "TEXT REFERENCES teams(id)");
  db.exec("CREATE INDEX IF NOT EXISTS rooms_team ON rooms (team)");
  // Rows from before `ver` get a version in id order; new ones take MAX(ver) + 1.
  db.exec("UPDATE messages SET ver = id WHERE ver = 0");
  // 0.5.0: tasks between an owner's own machines (docs/worker-api.md).
  db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id             TEXT PRIMARY KEY,
      owner          TEXT NOT NULL REFERENCES owners(id),
      name           TEXT NOT NULL,
      policy         TEXT NOT NULL,
      killed         INTEGER NOT NULL DEFAULT 0,
      last_seen      TEXT,
      worker_version TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS machines_owner ON machines (owner, id);
    CREATE TABLE IF NOT EXISTS tasks (
      id               TEXT PRIMARY KEY,
      owner            TEXT NOT NULL,
      machine          TEXT NOT NULL REFERENCES machines(id),
      created_by       TEXT NOT NULL,
      source_machine   TEXT,
      folder           TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      priority         TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
      status           TEXT NOT NULL,
      session_id       TEXT,
      result           TEXT,
      exit_code        INTEGER,
      error            TEXT,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      started_at       TEXT,
      finished_at      TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      policy_snapshot  TEXT NOT NULL,
      parent           TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_machine ON tasks (machine, status);
    CREATE INDEX IF NOT EXISTS tasks_owner ON tasks (owner, created_at);
    CREATE TABLE IF NOT EXISTS task_events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      task    TEXT NOT NULL,
      at      TEXT NOT NULL,
      actor   TEXT NOT NULL,
      machine TEXT,
      type    TEXT NOT NULL,
      data    TEXT
    );
    CREATE INDEX IF NOT EXISTS task_events_task ON task_events (task, id);
    CREATE INDEX IF NOT EXISTS task_events_machine ON task_events (machine, id);
    CREATE TABLE IF NOT EXISTS task_tool_approvals (
      id          TEXT PRIMARY KEY,
      task        TEXT NOT NULL,
      machine     TEXT NOT NULL,
      owner       TEXT NOT NULL,
      tool        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      category    TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      created_at  TEXT NOT NULL,
      decided_at  TEXT,
      decided_by  TEXT,
      expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_tool_approvals_task ON task_tool_approvals (task, status);
    CREATE INDEX IF NOT EXISTS task_tool_approvals_owner ON task_tool_approvals (owner, status);
    CREATE TABLE IF NOT EXISTS push_devices (
      token        TEXT PRIMARY KEY,
      owner        TEXT NOT NULL,
      platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      environment  TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
      app          TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_devices_owner ON push_devices (owner);
  `);
  // 0.6.0: projects group rooms and tasks; integrations (Linear) hold an
  // encrypted secret each; project_links tie a project to an external team/project.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      team_id     TEXT REFERENCES teams(id),
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repo_url    TEXT,
      created_at  TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (owner_id, slug)
    );
    CREATE INDEX IF NOT EXISTS projects_team ON projects (team_id);
    CREATE TABLE IF NOT EXISTS integrations (
      id              TEXT PRIMARY KEY,
      owner_id        TEXT NOT NULL REFERENCES owners(id),
      team_id         TEXT REFERENCES teams(id),
      kind            TEXT NOT NULL CHECK (kind IN ('linear')),
      name            TEXT NOT NULL,
      secret_enc      TEXT NOT NULL,
      secret_last4    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unchecked' CHECK (status IN ('unchecked', 'ok', 'error')),
      last_checked_at TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS integrations_owner ON integrations (owner_id);
    CREATE INDEX IF NOT EXISTS integrations_team ON integrations (team_id);
    CREATE TABLE IF NOT EXISTS project_links (
      project_id     TEXT NOT NULL REFERENCES projects(id),
      integration_id TEXT NOT NULL REFERENCES integrations(id),
      external_type  TEXT NOT NULL CHECK (external_type IN ('linear_team', 'linear_project')),
      external_id    TEXT NOT NULL,
      external_name  TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      PRIMARY KEY (project_id, integration_id, external_type)
    );
    CREATE INDEX IF NOT EXISTS project_links_integration ON project_links (integration_id);
  `);
  addColumn(db, "rooms", "project_id", "TEXT REFERENCES projects(id)");
  addColumn(db, "tasks", "project_id", "TEXT REFERENCES projects(id)");
  db.exec("CREATE INDEX IF NOT EXISTS rooms_project ON rooms (project_id)");
  db.exec("CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, created_at)");
  // The audit log and the task log are append-only: no row is ever changed or removed.
  for (const table of ["task_events", "audit"]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'append-only'); END;
    `);
  }
}

/** Adds a column when the table does not have it yet; true when it was added. */
function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  type: string,
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  return true;
}
