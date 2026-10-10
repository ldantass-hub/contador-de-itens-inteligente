import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: new Map<number, { id: number; username: string; password: string; role: string; authVersion: number; mustChangePassword: boolean }>(),
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
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../lib/db.js", () => state);
vi.mock("../lib/logger.js", () => ({
  logger: { info: state.logInfo, warn: state.logWarn, error: state.logError },
}));

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
  mustChangePassword = false,
) {
  const user = { id, username, role, password, authVersion, mustChangePassword };
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
      state.logInfo,
      state.logWarn,
      state.logError,
    ]) mock.mockReset();

    state.getAuthUserById.mockImplementation(async (id: number) => {
      const user = state.users.get(id);
      return user && {
        id: user.id,
        username: user.username,
        role: user.role,
        authVersion: user.authVersion,
        mustChangePassword: user.mustChangePassword,
      };
    });
    state.findUserByUsername.mockImplementation(async (username: string) =>
      [...state.users.values()].find(user => user.username === username),
    );
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

  it("reports a temporary password requirement on login and blocks protected routes until reset", async () => {
    const user = addUser(9, "temp-user", "user", await bcrypt.hash("temporary-pass", 4), 1, true);
    state.findUserByUsername.mockImplementation(async (username: string) =>
      username === user.username ? { ...user } : undefined,
    );

    const login = await send("/api/auth/login", {
      method: "POST",
      body: { username: "temp-user", password: "temporary-pass" },
    });
    const payload: unknown = await login.json();
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("mustChangePassword" in payload) ||
      typeof payload.mustChangePassword !== "boolean"
    ) {
      throw new Error("Login response did not include a boolean mustChangePassword field.");
    }
    const token = tokenFor(user);
    const protectedRoute = await send("/api/auth/me", { token });

    expect(login.status).toBe(200);
    expect(payload.mustChangePassword).toBe(true);
    expect(protectedRoute.status).toBe(403);
    expect(await protectedRoute.json()).toEqual({ error: "Você deve alterar sua senha antes de continuar." });
  });

  it("returns a valid login with an HttpOnly cookie and no token in the JSON body", async () => {
    const user = addUser(10, "valid-login", "user", await bcrypt.hash("valid-password", 4));

    const response = await send("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: "valid-password" },
    });
    const payload = await response.json() as Record<string, unknown>;
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(payload).toHaveProperty("user");
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("access_token");
    expect(cookie.startsWith("access_token=")).toBe(true);
    expect(cookie.toLowerCase()).toContain("httponly");
  });

  it("allows an authenticated regular user to access their own auth resource", async () => {
    const user = addUser(15, "allowed-user-resource", "user", "unused-hash");

    const response = await send("/api/auth/me", { token: tokenFor(user) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { userId: user.id, role: "user" } });
  });

  it("returns the same generic response for a wrong password and an unknown user", async () => {
    const user = addUser(11, "wrong-password-user", "user", await bcrypt.hash("correct-password", 4));

    const wrongPassword = await send("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: "incorrect-password" },
    });
    const unknownUser = await send("/api/auth/login", {
      method: "POST",
      body: { username: "missing-login-user", password: "incorrect-password" },
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "Usuário ou senha inválidos." });
    expect(await unknownUser.json()).toEqual({ error: "Usuário ou senha inválidos." });
  });

  it("finalizes an inactive session during login and emits session.finish only on success", async () => {
    const user = addUser(14, "inactive-session-login", "user", await bcrypt.hash("valid-password", 4));
    const sessionId = 78;
    state.getActiveSession.mockResolvedValue({
      id: sessionId,
      last_update: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    state.finalizeSession.mockResolvedValue(true);

    const response = await send("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: "valid-password" },
    });

    expect(response.status).toBe(200);
    expect(state.finalizeSession).toHaveBeenCalledWith(sessionId, user.id);
    expect(state.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.finish", result: "success", reason: "inactive_session_on_login" }),
      "Counting session finished",
    );
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

    const oldPasswordLogin = await send("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: "current-password" },
    });
    const newPasswordLogin = await send("/api/auth/login", {
      method: "POST",
      body: { username: user.username, password: "a-new-password-123" },
    });
    expect(oldPasswordLogin.status).toBe(401);
    expect(newPasswordLogin.status).toBe(200);
    expect(newPasswordLogin.headers.get("set-cookie")).toContain("access_token=");
  });

  it.each([
    ["incorrect current password", "wrong-current-password", "new-password-123", "new-password-123", "Não foi possível alterar a senha informada."],
    ["short new password", "current-password", "short", "short", "A nova senha deve ter no mínimo 12 caracteres."],
    ["mismatched confirmation", "current-password", "new-password-123", "other-password-123", "A confirmação da nova senha não confere."],
  ])("rejects password change with %s", async (_caseName, currentPassword, newPassword, confirmPassword, expectedError) => {
    const user = addUser(12, "password-validation", "user", await bcrypt.hash("current-password", 4));
    const response = await send("/api/auth/password", {
      method: "PUT",
      token: tokenFor(user),
      body: { currentPassword, newPassword, confirmPassword },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expectedError });
    expect(state.updateUserPassword).not.toHaveBeenCalled();
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

  it("allows an administrator to create a user with a valid role", async () => {
    const admin = addUser(1, "admin-create", "admin", "unused-hash");
    state.createUser.mockResolvedValue(44);

    const response = await send("/api/admin/users", {
      method: "POST",
      token: tokenFor(admin),
      body: { username: "  new-operator  ", password: "valid-password-123", role: "user" },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ user: { id: 44, username: "new-operator", role: "user" } });
    expect(state.createUser).toHaveBeenCalledWith("new-operator", "valid-password-123", "user");
  });

  it("maps a duplicate username conflict to HTTP 409", async () => {
    const admin = addUser(1, "admin-duplicate", "admin", "unused-hash");
    state.createUser.mockRejectedValue({ code: "23505" });

    const response = await send("/api/admin/users", {
      method: "POST",
      token: tokenFor(admin),
      body: { username: "existing-user", password: "valid-password-123", role: "user" },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Esse usuário já existe." });
  });

  it.each([
    ["short username", { username: "ab", password: "valid-password-123", role: "user" }],
    ["short password", { username: "new-user", password: "short", role: "user" }],
    ["invalid role", { username: "new-user", password: "valid-password-123", role: "superuser" }],
  ])("rejects user creation with %s before calling the database mock", async (_caseName, body) => {
    const admin = addUser(1, "admin-validation", "admin", "unused-hash");

    const response = await send("/api/admin/users", {
      method: "POST",
      token: tokenFor(admin),
      body,
    });

    expect(response.status).toBe(400);
    expect(state.createUser).not.toHaveBeenCalled();
  });

  it("blocks a regular user from administrator routes", async () => {
    const user = addUser(13, "regular-user", "user", "unused-hash");

    const response = await send("/api/admin/users", { token: tokenFor(user) });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Acesso restrito a administradores." });
    expect(state.getAllUsers).not.toHaveBeenCalled();
  });

  it("blocks a regular user from deleting another account before the delete mock", async () => {
    const user = addUser(16, "regular-delete-user", "user", "unused-hash");

    const response = await send("/api/admin/users/17", { method: "DELETE", token: tokenFor(user) });

    expect(response.status).toBe(403);
    expect(state.removeUser).not.toHaveBeenCalled();
  });

  it("rejects an administrator deleting their own account", async () => {
    const admin = addUser(1, "admin-self-delete", "admin", "unused-hash");

    const response = await send("/api/admin/users/1", { method: "DELETE", token: tokenFor(admin) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Você não pode remover sua própria conta." });
    expect(state.removeUser).toHaveBeenCalledWith(admin.id, admin.id);
    expect(state.users.has(admin.id)).toBe(true);
  });

  it("returns the generic server error when user deletion fails", async () => {
    const admin = addUser(1, "admin-delete-error", "admin", "unused-hash");
    state.removeUser.mockRejectedValue(new Error("database operation failed"));

    const response = await send("/api/admin/users/2", { method: "DELETE", token: tokenFor(admin) });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Não foi possível remover o usuário." });
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
    const loginAfterDelete = await send("/api/auth/login", {
      method: "POST",
      body: { username: deletedAdmin.username, password: "unused-password" },
    });

    expect(deleted.status).toBe(200);
    expect(state.users.has(deletedAdmin.id)).toBe(false);
    expect(oldTokenResponse.status).toBe(401);
    expect(loginAfterDelete.status).toBe(401);
    expect(await loginAfterDelete.json()).toEqual({ error: "Usuário ou senha inválidos." });
  });
});