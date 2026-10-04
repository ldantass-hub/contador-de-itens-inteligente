import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: new Map<number, { id: number; username: string; password: string; role: string; authVersion: number }>(),
  getAuthUserById: vi.fn(),
  findUserByUsername: vi.fn(),
  findUserById: vi.fn(),
  getActiveSession: vi.fn(),
  finalizeSession: vi.fn(),
  updateUserPassword: vi.fn(),
  revokeAuthVersion: vi.fn(),
  updateUserRole: vi.fn(),
  getAllUsers: vi.fn(),
  getAllSessions: vi.fn(),
  getSessionById: vi.fn(),
  getSessionCounts: vi.fn(),
  getSessionOperators: vi.fn(),
  createUser: vi.fn(),
  removeUser: vi.fn(),
}));

vi.mock("../lib/db.js", () => state);

const SECRET = "auth-revocation-test-secret-at-least-32-characters";
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
let signToken: typeof import("../lib/jwtUtils.js").signToken;

function addUser(
  id: number,
  username: string,
  role: string,
  password: string,
  authVersion = 1,
) {
  const user = { id, username, role, password, authVersion };
  state.users.set(id, user);
  return user;
}

function tokenFor(user: ReturnType<typeof addUser>): string {
  return signToken({
    userId: user.id,
    username: user.username,
    role: user.role,
    authVersion: user.authVersion,
  });
}

async function send(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers = new Headers({ Origin: "http://localhost:5173" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Cookie", `access_token=${options.token}`);

  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("auth-version revocation flows", () => {
  beforeAll(async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();

    const [{ default: authRouter }, { default: adminRouter }, { signToken: sign }] = await Promise.all([
      import("./auth.js"),
      import("./adminRoute.js"),
      import("../lib/jwtUtils.js"),
    ]);
    signToken = sign;

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    state.users.clear();
    for (const mock of [
      state.getAuthUserById,
      state.findUserByUsername,
      state.findUserById,
      state.getActiveSession,
      state.finalizeSession,
      state.updateUserPassword,
      state.revokeAuthVersion,
      state.updateUserRole,
      state.getAllUsers,
      state.getAllSessions,
      state.getSessionById,
      state.getSessionCounts,
      state.getSessionOperators,
      state.createUser,
      state.removeUser,
    ]) mock.mockReset();

    state.getAuthUserById.mockImplementation(async (id: number) => {
      const user = state.users.get(id);
      return user && { id: user.id, username: user.username, role: user.role, authVersion: user.authVersion };
    });
    state.findUserById.mockImplementation(async (id: number) => state.users.get(id));
    state.getActiveSession.mockResolvedValue(undefined);
    state.finalizeSession.mockResolvedValue(false);
    state.updateUserPassword.mockImplementation(async (id: number, password: string) => {
      const user = state.users.get(id);
      if (!user) return false;
      user.password = password;
      user.authVersion += 1;
      return true;
    });
    state.revokeAuthVersion.mockImplementation(async (id: number, expectedVersion: number) => {
      const user = state.users.get(id);
      if (!user || user.authVersion !== expectedVersion) return false;
      user.authVersion += 1;
      return true;
    });
    state.updateUserRole.mockImplementation(async (id: number, role: "user" | "admin") => {
      const user = state.users.get(id);
      if (!user) return undefined;
      user.role = role;
      user.authVersion += 1;
      return { id: user.id, username: user.username, role: user.role, authVersion: user.authVersion };
    });
    state.getAllUsers.mockImplementation(async () => [...state.users.values()].map(({ id, username, role }) => ({ id, username, role })));
    state.createUser.mockResolvedValue(100);
    state.removeUser.mockImplementation(async (id: number, actingUserId: number) => {
      if (id === actingUserId) return "self";
      return state.users.delete(id) ? "deleted" : "not_found";
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    vi.unstubAllEnvs();
  });

  it("invalidates a token after the password-change route succeeds", async () => {
    const passwordHash = await bcrypt.hash("current-password", 4);
    const user = addUser(7, "operator", "user", passwordHash);
    const oldToken = tokenFor(user);

    const changed = await send("/api/auth/password", {
      method: "PUT",
      token: oldToken,
      body: {
        currentPassword: "current-password",
        newPassword: "a-new-password-123",
        confirmPassword: "a-new-password-123",
      },
    });
    const oldTokenResponse = await send("/api/auth/me", { token: oldToken });

    expect(changed.status).toBe(200);
    expect(user.authVersion).toBe(2);
    expect(oldTokenResponse.status).toBe(401);
  });

  it("invalidates existing tokens on logout and clears the cookie", async () => {
    const user = addUser(8, "operator", "user", "unused-hash");
    const oldToken = tokenFor(user);

    const loggedOut = await send("/api/auth/logout", { method: "POST", token: oldToken });
    const oldTokenResponse = await send("/api/auth/me", { token: oldToken });

    expect(loggedOut.status).toBe(200);
    expect(loggedOut.headers.get("set-cookie")).toContain("access_token=;");
    expect(user.authVersion).toBe(2);
    expect(oldTokenResponse.status).toBe(401);
  });

  it("invalidates a user's token after an administrator changes the role", async () => {
    const admin = addUser(1, "admin", "admin", "unused-hash");
    const target = addUser(2, "operator", "user", "unused-hash");
    const adminToken = tokenFor(admin);
    const oldTargetToken = tokenFor(target);

    const changed = await send("/api/admin/users/2/role", {
      method: "PATCH",
      token: adminToken,
      body: { role: "admin" },
    });
    const oldTokenResponse = await send("/api/auth/me", { token: oldTargetToken });
    const currentToken = tokenFor(target);
    const adminAccess = await send("/api/admin/users", { token: currentToken });

    expect(changed.status).toBe(200);
    expect(target.authVersion).toBe(2);
    expect(oldTokenResponse.status).toBe(401);
    expect(adminAccess.status).toBe(200);
  });

  it("prevents an administrator from changing their own role", async () => {
    const admin = addUser(1, "admin", "admin", "unused-hash");

    const changed = await send("/api/admin/users/1/role", {
      method: "PATCH",
      token: tokenFor(admin),
      body: { role: "user" },
    });

    expect(changed.status).toBe(409);
    expect(admin.role).toBe("admin");
    expect(admin.authVersion).toBe(1);
    expect(state.updateUserRole).not.toHaveBeenCalled();
  });

  it("rejects a deleted administrator's previously valid token", async () => {
    const actor = addUser(1, "actor", "admin", "unused-hash");
    const deletedAdmin = addUser(2, "former-admin", "admin", "unused-hash");
    const actorToken = tokenFor(actor);
    const deletedAdminToken = tokenFor(deletedAdmin);

    const deleted = await send("/api/admin/users/2", { method: "DELETE", token: actorToken });
    const oldTokenResponse = await send("/api/admin/users", { token: deletedAdminToken });

    expect(deleted.status).toBe(200);
    expect(state.users.has(deletedAdmin.id)).toBe(false);
    expect(oldTokenResponse.status).toBe(401);
  });
});