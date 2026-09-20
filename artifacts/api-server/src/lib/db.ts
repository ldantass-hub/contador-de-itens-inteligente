import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import type { Organization } from "./organizations.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH  = path.join(DATA_DIR, "estoque.db");
export const LOG_PATH = path.join(DATA_DIR, "ignored_inputs.txt");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

/* ── Schema ───────────────────────────────────────────────────────────────── */

db.exec(`
  CREATE TABLE IF NOT EXISTS itens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo     TEXT    UNIQUE NOT NULL,
    quantidade INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    UNIQUE NOT NULL,
    password TEXT    NOT NULL,
    role     TEXT    NOT NULL DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    organization TEXT,
    start_time  TEXT    NOT NULL DEFAULT (datetime('now')),
    end_time    TEXT,
    last_update TEXT    NOT NULL DEFAULT (datetime('now')),
    status      TEXT    NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS counts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    code       TEXT    NOT NULL,
    quantity   INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, code)
  );
`);

/* Add the organization field without breaking databases created by older builds. */
const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
if (!sessionColumns.some(column => column.name === "organization")) {
  db.exec("ALTER TABLE sessions ADD COLUMN organization TEXT");
}

/* Indexes and invariants used by concurrent requests and the supervisor panel. */
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase
    ON users (lower(username));

  CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_active_per_user
    ON sessions (user_id)
    WHERE status = 'active';

  CREATE INDEX IF NOT EXISTS sessions_start_time_idx
    ON sessions (start_time);

  CREATE INDEX IF NOT EXISTS sessions_user_status_idx
    ON sessions (user_id, status);

  CREATE INDEX IF NOT EXISTS counts_session_id_idx
    ON counts (session_id);
`);

/* ── 180-day data retention cleanup ──────────────────────────────────────── */

db.exec(`
  DELETE FROM counts
  WHERE session_id NOT IN (
    SELECT id FROM sessions
    WHERE start_time >= datetime('now', '-180 days')
  );

  DELETE FROM sessions
  WHERE start_time < datetime('now', '-180 days');
`);

/* ── Seed default users (per-user check so re-runs are safe) ─────────────── */

function seedUser(username: string, password: string, role: string): void {
  const exists = db.prepare("SELECT 1 FROM users WHERE username = ?").get(username);
  if (!exists) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run(username, hash, role);
  }
}

seedUser("lael1.dantas",  "@manaus2026", "user");
seedUser("joarez.silva",  "@manaus2026", "admin");

/* ── Types ────────────────────────────────────────────────────────────────── */

export interface DbUser {
  id: number;
  username: string;
  password: string;
  role: string;
}

export interface DbSession {
  id: number;
  user_id: number;
  organization: Organization | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
}

export interface DbCount {
  id: number;
  session_id: number;
  code: string;
  quantity: number;
}

/* ── User helpers ─────────────────────────────────────────────────────────── */

export function findUserByUsername(username: string): DbUser | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as DbUser | undefined;
}

export function findUserById(id: number): DbUser | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as DbUser | undefined;
}

export function getAllUsers(): Pick<DbUser, "id" | "username" | "role">[] {
  return db.prepare("SELECT id, username, role FROM users ORDER BY username").all() as Pick<DbUser, "id" | "username" | "role">[];
}

export function createUser(username: string, password: string, role: "user" | "admin"): number {
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run(username, hash, role);
  return result.lastInsertRowid as number;
}

/* ── Session helpers ──────────────────────────────────────────────────────── */

export function getActiveSession(userId: number): DbSession | undefined {
  return db.prepare(
    "SELECT * FROM sessions WHERE user_id = ? AND status = 'active' ORDER BY start_time DESC LIMIT 1"
  ).get(userId) as DbSession | undefined;
}

export function createSession(userId: number, organization: Organization | null = null): DbSession {
  const result = db.prepare(
    "INSERT INTO sessions (user_id, organization) VALUES (?, ?)"
  ).run(userId, organization);
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(result.lastInsertRowid) as DbSession;
}

export type OrganizationSelectionResult =
  | { kind: "selected"; session: DbSession }
  | { kind: "conflict"; session: DbSession };

/**
 * Selects an organization and creates/updates the inventory session atomically.
 * The partial unique index above is the final guard against duplicate active
 * sessions if more than one API process ever handles the same user.
 */
export function selectOrganizationSession(
  userId: number,
  organization: Organization,
): OrganizationSelectionResult {
  return db.transaction(() => {
    const existing = getActiveSession(userId);
    if (existing) {
      if (existing.organization && existing.organization !== organization) {
        return { kind: "conflict", session: existing } as const;
      }

      if (!existing.organization) {
        db.prepare(
          "UPDATE sessions SET organization = ?, last_update = datetime('now') WHERE id = ? AND status = 'active'"
        ).run(organization, existing.id);
      }

      return {
        kind: "selected",
        session: getSessionById(existing.id)!,
      } as const;
    }

    const result = db.prepare(
      "INSERT INTO sessions (user_id, organization) VALUES (?, ?)"
    ).run(userId, organization);

    return {
      kind: "selected",
      session: getSessionById(result.lastInsertRowid as number)!,
    } as const;
  })();
}

export function assignSessionOrganization(
  sessionId: number,
  userId: number,
  organization: Organization,
): DbSession | undefined {
  const session = getSessionById(sessionId);
  if (!session || session.user_id !== userId || session.status !== "active") {
    return undefined;
  }

  if (session.organization && session.organization !== organization) {
    return undefined;
  }

  if (!session.organization) {
    db.prepare(
      "UPDATE sessions SET organization = ?, last_update = datetime('now') WHERE id = ?"
    ).run(organization, sessionId);
  }

  return getSessionById(sessionId);
}

export function finalizeSession(sessionId: number): void {
  db.prepare(
    "UPDATE sessions SET status = 'finished', end_time = datetime('now') WHERE id = ?"
  ).run(sessionId);
}

export function updateSessionPing(sessionId: number): void {
  db.prepare("UPDATE sessions SET last_update = datetime('now') WHERE id = ?").run(sessionId);
}

export function getSessionById(sessionId: number): DbSession | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as DbSession | undefined;
}

export interface AdminSession {
  id: number;
  username: string;
  organization: Organization | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
  total_quantity: number;
}

export function getAllSessions(filters: {
  userId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  organization?: Organization;
} = {}): AdminSession[] {
  let query = `
    SELECT s.id, u.username, s.organization, s.start_time, s.end_time, s.last_update, s.status,
           COALESCE(SUM(c.quantity), 0) as total_quantity
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN counts c ON c.session_id = s.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (filters.userId) {
    query += " AND s.user_id = ?";
    params.push(filters.userId);
  }
  if (filters.status) {
    query += " AND s.status = ?";
    params.push(filters.status);
  }
  if (filters.dateFrom) {
    query += " AND s.start_time >= ?";
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    query += " AND s.start_time <= ?";
    params.push(filters.dateTo + " 23:59:59");
  }
  if (filters.organization) {
    query += " AND s.organization = ?";
    params.push(filters.organization);
  }

  query += " GROUP BY s.id ORDER BY s.start_time DESC";
  return db.prepare(query).all(...params) as AdminSession[];
}

/* ── Count helpers ────────────────────────────────────────────────────────── */

export function upsertCount(sessionId: number, code: string, quantity: number): void {
  db.prepare(`
    INSERT INTO counts (session_id, code, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, code) DO UPDATE SET quantity = excluded.quantity
  `).run(sessionId, code, quantity);
}

export type SessionWriteResult = "saved" | "not_found" | "forbidden" | "finished";

/**
 * Saves a count and updates activity in one transaction. The session status
 * is checked again inside the transaction so a finalization cannot interleave
 * with a save and leave a partially updated session.
 */
export function saveSessionCount(
  sessionId: number,
  userId: number,
  code: string,
  quantity: number,
): SessionWriteResult {
  return db.transaction(() => {
    const session = getSessionById(sessionId);
    if (!session) return "not_found" as const;
    if (session.user_id !== userId) return "forbidden" as const;
    if (session.status !== "active") return "finished" as const;

    upsertCount(sessionId, code, quantity);
    updateSessionPing(sessionId);
    return "saved" as const;
  })();
}

export function saveAndFinalizeSession(
  sessionId: number,
  userId: number,
  code: string,
  quantity: number,
): SessionWriteResult {
  return db.transaction(() => {
    const session = getSessionById(sessionId);
    if (!session) return "not_found" as const;
    if (session.user_id !== userId) return "forbidden" as const;
    if (session.status !== "active") return "finished" as const;

    upsertCount(sessionId, code, quantity);
    finalizeSession(sessionId);
    return "saved" as const;
  })();
}

export function getSessionCounts(sessionId: number): { code: string; quantity: number }[] {
  return db.prepare(
    "SELECT code, quantity FROM counts WHERE session_id = ? ORDER BY code"
  ).all(sessionId) as { code: string; quantity: number }[];
}

/* ── Legacy itens helpers (global aggregate) ──────────────────────────────── */

export function upsertItem(codigo: string, quantidade: number): void {
  db.prepare(`
    INSERT INTO itens (codigo, quantidade)
    VALUES (?, ?)
    ON CONFLICT(codigo) DO UPDATE SET quantidade = itens.quantidade + excluded.quantidade
  `).run(codigo, quantidade);
}

export function getAllItems(): { id: number; codigo: string; quantidade: number }[] {
  return db.prepare("SELECT * FROM itens ORDER BY codigo").all() as { id: number; codigo: string; quantidade: number }[];
}

export function appendIgnoredLog(lines: string[]): void {
  if (lines.length === 0) return;
  const timestamp = new Date().toISOString();
  const block = lines.map(l => `[${timestamp}] ${l}`).join("\n") + "\n";
  fs.appendFileSync(LOG_PATH, block, "utf-8");
}
