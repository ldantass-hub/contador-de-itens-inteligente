import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuthUserById } from "../lib/db.js";

vi.mock("../lib/db.js", () => ({
  getAuthUserById: vi.fn(),
}));

const VALID_SECRET = "unit-test-secret-with-at-least-32-characters";

function createRequest(token?: string): Request {
  return {
    cookies: token === undefined ? {} : { access_token: token },
  } as Request;
}

function createResponse(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function createNext() {
  return vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", VALID_SECRET);
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CORS_ORIGIN", "");
  vi.resetModules();
  vi.mocked(getAuthUserById).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("authenticate", () => {
  it("rejects a request without an access token cookie", async () => {
    const { authenticate } = await import("./authenticate.js");
    const req = createRequest();
    const res = createResponse();
    const next = createNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Não autenticado." });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid access token", async () => {
    const { authenticate } = await import("./authenticate.js");
    const req = createRequest("invalid-token");
    const res = createResponse();
    const next = createNext();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Token inválido ou expirado." });
    expect(next).not.toHaveBeenCalled();
  });

  it("sets the authenticated user and continues for a valid token", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate } = await import("./authenticate.js");
    const user = { userId: 17, username: "operator", role: "user", authVersion: 1 };
    vi.mocked(getAuthUserById).mockResolvedValue({
      id: user.userId,
      username: user.username,
      role: user.role,
      authVersion: user.authVersion,
      mustChangePassword: false,
    });
    const req = createRequest(signToken(user));
    const res = createResponse();
    const next = createNext();

    await authenticate(req, res, next);

    expect(req.user).toEqual({ ...user, mustChangePassword: false });
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects protected routes for users who must change their password", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate } = await import("./authenticate.js");
    vi.mocked(getAuthUserById).mockResolvedValue({
      id: 17,
      username: "operator",
      role: "user",
      authVersion: 1,
      mustChangePassword: true,
    });
    const req = createRequest(signToken({
      userId: 17,
      username: "operator",
      role: "user",
      authVersion: 1,
    }));
    req.originalUrl = "/api/auth/me";
    req.path = "/me";
    const res = createResponse();
    const next = createNext();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Você deve alterar sua senha antes de continuar." });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["password change"],
    ["role change"],
    ["logout"],
  ])("rejects a token issued before %s", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate } = await import("./authenticate.js");
    vi.mocked(getAuthUserById).mockResolvedValue({
      id: 17,
      username: "operator",
      role: "user",
      authVersion: 2,
    });
    const req = createRequest(signToken({
      userId: 17,
      username: "operator",
      role: "user",
      authVersion: 1,
    }));
    const res = createResponse();
    const next = createNext();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an administrator token after that user has been deleted", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate } = await import("./authenticate.js");
    vi.mocked(getAuthUserById).mockResolvedValue(undefined);
    const req = createRequest(signToken({
      userId: 17,
      username: "former-admin",
      role: "admin",
      authVersion: 1,
    }));
    const res = createResponse();
    const next = createNext();

    await authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the current database role instead of the role in the token", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate, requireAdmin } = await import("./authenticate.js");
    vi.mocked(getAuthUserById).mockResolvedValue({
      id: 17,
      username: "operator",
      role: "admin",
      authVersion: 1,
    });
    const req = createRequest(signToken({
      userId: 17,
      username: "stale-name",
      role: "user",
      authVersion: 1,
    }));
    const res = createResponse();
    const next = createNext();

    await authenticate(req, res, next);
    requireAdmin(req, res, next);

    expect(req.user).toMatchObject({ username: "operator", role: "admin" });
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects a stale administrator role when the database now has a user role", async () => {
    const { signToken } = await import("../lib/jwtUtils.js");
    const { authenticate, requireAdmin } = await import("./authenticate.js");
    vi.mocked(getAuthUserById).mockResolvedValue({
      id: 17,
      username: "operator",
      role: "user",
      authVersion: 1,
    });
    const req = createRequest(signToken({
      userId: 17,
      username: "operator",
      role: "admin",
      authVersion: 1,
    }));
    const res = createResponse();
    const authenticatedNext = createNext();
    const adminNext = createNext();

    await authenticate(req, res, authenticatedNext);
    requireAdmin(req, res, adminNext);

    expect(authenticatedNext).toHaveBeenCalledOnce();
    expect(adminNext).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("requireAdmin", () => {
  it.each([undefined, "user"])("rejects a non-admin user (%s)", async (role) => {
    const { requireAdmin } = await import("./authenticate.js");
    const req = { user: role ? { userId: 17, username: "operator", role } : undefined } as Request;
    const res = createResponse();
    const next = createNext();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Acesso restrito a administradores." });
    expect(next).not.toHaveBeenCalled();
  });

  it("continues for an admin user", async () => {
    const { requireAdmin } = await import("./authenticate.js");
    const req = {
      user: { userId: 1, username: "admin", role: "admin" },
    } as Request;
    const res = createResponse();
    const next = createNext();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("requireTrustedOrigin", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("allows non-mutating %s requests", async (method) => {
    const { requireTrustedOrigin } = await import("./requireTrustedOrigin.js");
    const req = { method, get: vi.fn() } as unknown as Request;
    const res = createResponse();
    const next = createNext();

    requireTrustedOrigin(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.get).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://untrusted.example.com"])(
    "rejects a mutating request with a missing or untrusted origin (%s)",
    async (origin) => {
      const { requireTrustedOrigin } = await import("./requireTrustedOrigin.js");
      const req = {
        method: "POST",
        get: vi.fn(() => origin),
      } as unknown as Request;
      const res = createResponse();
      const next = createNext();

      requireTrustedOrigin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: "Origem da requisição não permitida." });
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "allows %s from the trusted development origin",
    async (method) => {
      const { requireTrustedOrigin } = await import("./requireTrustedOrigin.js");
      const req = {
        method,
        get: vi.fn(() => "http://localhost:5173"),
      } as unknown as Request;
      const res = createResponse();
      const next = createNext();

      requireTrustedOrigin(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
    },
  );
});