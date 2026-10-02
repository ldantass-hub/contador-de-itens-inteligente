import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db as postgresDb } from "@workspace/db";
import { counts, itens, sessions, users } from "@workspace/db/schema";
import type { Organization } from "./organizations.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export const LOG_PATH = path.join(DATA_DIR, "ignored_inputs.txt");
export const db = postgresDb;

/* ── Seed default users (per-user check so re-runs are safe) ─────────────── */

async function seedUser(username: string, password: string, role: string): Promise<void> {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
  if (!exists) {
    const hash = await bcrypt.hash(password, 10);
    await db.insert(users).values({ username, password: hash, role });
  }
}

async function initializeDatabase(): Promise<void> {
  await db.delete(counts).where(sql`NOT EXISTS (
    SELECT 1 FROM ${sessions}
    WHERE ${sessions.id} = ${counts.sessionId}
      AND ${sessions.startTime} >= now() - interval '180 days'
  )`);
  await db.delete(sessions).where(sql`${sessions.startTime} < now() - interval '180 days'`);

  const bootstrapUserUsername = process.env.BOOTSTRAP_USER_USERNAME;
  const bootstrapUserPassword = process.env.BOOTSTRAP_USER_PASSWORD;
  if (bootstrapUserUsername && bootstrapUserPassword) {
    await seedUser(bootstrapUserUsername, bootstrapUserPassword, "user");
  }

  const bootstrapAdminUsername = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const bootstrapAdminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (bootstrapAdminUsername && bootstrapAdminPassword) {
    await seedUser(bootstrapAdminUsername, bootstrapAdminPassword, "admin");
  }
}

await initializeDatabase();

/* ── Types ────────────────────────────────────────────────────────────────── */

export interface DbUser {
  id: number;
  username: string;
  password: string;
  role: string;
}

export interface DbSession {
  id: number;
  user_id: number | null;
  operator_user_id: number;
  operator_username: string;
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

export async function findUserByUsername(username: string): Promise<DbUser | undefined> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return user ? { id: user.id, username: user.username, password: user.password, role: user.role } : undefined;
}

export async function findUserById(id: number): Promise<DbUser | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user ? { id: user.id, username: user.username, password: user.password, role: user.role } : undefined;
}

export async function getAllUsers(): Promise<Pick<DbUser, "id" | "username" | "role">[]> {
  return db.select({ id: users.id, username: users.username, role: users.role }).from(users).orderBy(users.username);
}

export async function createUser(username: string, password: string, role: "user" | "admin"): Promise<number> {
  const hash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(users).values({ username, password: hash, role }).returning({ id: users.id });
  return user.id;
}

export type RemoveUserResult = "deleted" | "not_found" | "self";

export async function removeUser(userId: number, actingUserId: number): Promise<RemoveUserResult> {
  if (userId === actingUserId) return "self";

  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (!target) return "not_found";

    const userSessions = await tx.select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sessions.id)
      .for("update");

    if (userSessions.length > 0) {
      await tx.update(sessions)
        .set({ status: "finished", endTime: new Date().toISOString() })
        .where(and(eq(sessions.userId, userId), eq(sessions.status, "active")));
    }

    await tx.delete(users).where(eq(users.id, userId));
    return "deleted";
  });
}

export async function updateUserPassword(userId: number, passwordHash: string): Promise<boolean> {
  const result = await db.update(users)
    .set({ password: passwordHash })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return result.length > 0;
}

/* ── Session helpers ──────────────────────────────────────────────────────── */

function mapSession(session: typeof sessions.$inferSelect): DbSession {
  const toIsoTimestamp = (value: string | null): string | null =>
    value === null ? null : new Date(value).toISOString();

  return {
    id: session.id,
    user_id: session.userId,
    operator_user_id: session.operatorUserId,
    operator_username: session.operatorUsername,
    organization: session.organization as Organization | null,
    start_time: toIsoTimestamp(session.startTime)!,
    end_time: toIsoTimestamp(session.endTime),
    last_update: toIsoTimestamp(session.lastUpdate)!,
    status: session.status,
  };
}

export async function getActiveSession(userId: number): Promise<DbSession | undefined> {
  const [session] = await db.select().from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.status, "active")))
    .orderBy(desc(sessions.startTime)).limit(1);
  return session ? mapSession(session) : undefined;
}

export async function createSession(userId: number, organization: Organization | null = null): Promise<DbSession> {
  return db.transaction(async (tx) => {
    const [operator] = await tx.select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .for("key share")
      .limit(1);
    if (!operator) throw new Error("Cannot create a session for a missing user.");

    const [session] = await tx.insert(sessions).values({
      userId,
      operatorUserId: operator.id,
      operatorUsername: operator.username,
      organization,
    }).returning();
    return mapSession(session);
  });
}

export type OrganizationSelectionResult =
  | { kind: "selected"; session: DbSession }
  | { kind: "conflict"; session: DbSession };

/**
 * Selects an organization and creates/updates the inventory session atomically.
 * The partial unique index above is the final guard against duplicate active
 * sessions if more than one API process ever handles the same user.
 */
export async function selectOrganizationSession(
  userId: number,
  organization: Organization,
): Promise<OrganizationSelectionResult> {
  return db.transaction(async (tx) => {
    const [operator] = await tx.select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .for("key share")
      .limit(1);
    if (!operator) throw new Error("Cannot create a session for a missing user.");

    const [existing] = await tx.select().from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.status, "active")))
      .orderBy(desc(sessions.startTime)).for("update").limit(1);
    if (existing) {
      const mappedExisting = mapSession(existing);
      if (mappedExisting.organization && mappedExisting.organization !== organization) {
        return { kind: "conflict", session: mappedExisting } as const;
      }

      if (!existing.organization) {
        const [updated] = await tx.update(sessions)
          .set({ organization, lastUpdate: new Date().toISOString() })
          .where(and(eq(sessions.id, existing.id), eq(sessions.status, "active")))
          .returning();
        return { kind: "selected", session: mapSession(updated) } as const;
      }

      return { kind: "selected", session: mappedExisting } as const;
    }

    const [created] = await tx.insert(sessions).values({
      userId,
      operatorUserId: operator.id,
      operatorUsername: operator.username,
      organization,
    }).returning();
    return { kind: "selected", session: mapSession(created) } as const;
  });
}

export async function assignSessionOrganization(
  sessionId: number,
  userId: number,
  organization: Organization,
): Promise<DbSession | undefined> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update")
      .limit(1);
    if (!session || session.userId !== userId || session.status !== "active") return undefined;
    if (session.organization && session.organization !== organization) return undefined;

    if (!session.organization) {
      const [updated] = await tx.update(sessions)
        .set({ organization, lastUpdate: new Date().toISOString() })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.status, "active")))
        .returning();
      return updated ? mapSession(updated) : undefined;
    }

    return mapSession(session);
  });
}

export async function finalizeSession(sessionId: number, userId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions)
      .where(eq(sessions.id, sessionId))
      .for("update")
      .limit(1);
    if (!session || session.userId !== userId || session.status !== "active") return false;

    await tx.update(sessions)
      .set({ status: "finished", endTime: new Date().toISOString() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.status, "active")));
    return true;
  });
}

export async function updateSessionPing(sessionId: number, userId: number): Promise<boolean> {
  const updated = await db.update(sessions)
    .set({ lastUpdate: new Date().toISOString() })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.status, "active")))
    .returning({ id: sessions.id });
  return updated.length > 0;
}

export async function getSessionById(sessionId: number): Promise<DbSession | undefined> {
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return session ? mapSession(session) : undefined;
}

export interface AdminSession {
  id: number;
  username: string;
  operator_user_id: number;
  organization: Organization | null;
  start_time: string;
  end_time: string | null;
  last_update: string;
  status: string;
  total_quantity: number;
}

export async function getAllSessions(filters: {
  userId?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  organization?: Organization;
} = {}): Promise<AdminSession[]> {
  const conditions = [];
  if (filters.userId) conditions.push(eq(sessions.operatorUserId, filters.userId));
  if (filters.status) conditions.push(eq(sessions.status, filters.status));
  if (filters.dateFrom) conditions.push(gte(sessions.startTime, filters.dateFrom));
  if (filters.dateTo) conditions.push(lte(sessions.startTime, `${filters.dateTo} 23:59:59`));
  if (filters.organization) conditions.push(eq(sessions.organization, filters.organization));

  const rows = await db.select({
    id: sessions.id,
    username: sessions.operatorUsername,
    operator_user_id: sessions.operatorUserId,
    organization: sessions.organization,
    start_time: sessions.startTime,
    end_time: sessions.endTime,
    last_update: sessions.lastUpdate,
    status: sessions.status,
    total_quantity: sql<number>`coalesce(sum(${counts.quantity}), 0)`,
  }).from(sessions)
    .leftJoin(counts, eq(counts.sessionId, sessions.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(sessions.id)
    .orderBy(desc(sessions.startTime));

  return rows.map(row => ({ ...row, organization: row.organization as Organization | null, total_quantity: Number(row.total_quantity) }));
}

export async function getSessionOperators(): Promise<{ id: number; username: string }[]> {
  return db.selectDistinct({ id: sessions.operatorUserId, username: sessions.operatorUsername })
    .from(sessions)
    .orderBy(sessions.operatorUsername);
}

/* ── Count helpers ────────────────────────────────────────────────────────── */

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
): Promise<SessionWriteResult> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions)
      .where(eq(sessions.id, sessionId)).for("update").limit(1);
    if (!session) return "not_found" as const;
    if (session.userId !== userId) return "forbidden" as const;
    if (session.status !== "active") return "finished" as const;

    await tx.insert(counts).values({ sessionId, code, quantity })
      .onConflictDoUpdate({ target: [counts.sessionId, counts.code], set: { quantity: sql`excluded.quantity` } });
    await tx.update(sessions).set({ lastUpdate: new Date().toISOString() }).where(eq(sessions.id, sessionId));
    return "saved" as const;
  });
}

export function saveAndFinalizeSession(
  sessionId: number,
  userId: number,
  code: string,
  quantity: number,
): Promise<SessionWriteResult> {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions)
      .where(eq(sessions.id, sessionId)).for("update").limit(1);
    if (!session) return "not_found" as const;
    if (session.userId !== userId) return "forbidden" as const;
    if (session.status !== "active") return "finished" as const;

    await tx.insert(counts).values({ sessionId, code, quantity })
      .onConflictDoUpdate({ target: [counts.sessionId, counts.code], set: { quantity: sql`excluded.quantity` } });
    await tx.update(sessions).set({ status: "finished", endTime: new Date().toISOString() }).where(eq(sessions.id, sessionId));
    return "saved" as const;
  });
}

export async function getSessionCounts(sessionId: number): Promise<{ code: string; quantity: number }[]> {
  return db.select({ code: counts.code, quantity: counts.quantity }).from(counts)
    .where(eq(counts.sessionId, sessionId)).orderBy(counts.code);
}

/* ── Legacy itens helpers (global aggregate) ──────────────────────────────── */

export async function upsertItem(codigo: string, quantidade: number): Promise<void> {
  await db.insert(itens).values({ codigo, quantidade })
    .onConflictDoUpdate({ target: itens.codigo, set: { quantidade: sql`${itens.quantidade} + excluded.quantidade` } });
}

export async function getAllItems(): Promise<{ id: number; codigo: string; quantidade: number }[]> {
  return db.select().from(itens).orderBy(itens.codigo);
}

export function appendIgnoredLog(lines: string[]): void {
  if (lines.length === 0) return;
  const timestamp = new Date().toISOString();
  const block = lines.map(l => `[${timestamp}] ${l}`).join("\n") + "\n";
  fs.appendFileSync(LOG_PATH, block, "utf-8");
}
