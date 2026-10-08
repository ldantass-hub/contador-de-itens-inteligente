import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { getActiveSession } = vi.hoisted(() => ({
  getActiveSession: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  getActiveSession,
  createSession: vi.fn(),
  selectOrganizationSession: vi.fn(),
  finalizeSession: vi.fn(),
  updateSessionPing: vi.fn(),
  getSessionById: vi.fn(),
  saveSessionCount: vi.fn(),
  saveAndFinalizeSession: vi.fn(),
  appendIgnoredLog: vi.fn(),
}));

vi.mock("../middlewares/authenticate.js", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { userId: 1 } as NonNullable<express.Request["user"]>;
    next();
  },
}));

import sessionsRouter from "./sessionsRoute.js";

describe("GET /api/sessions/current", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api/sessions", sessionsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("returns a historical TV session unchanged", async () => {
    getActiveSession.mockResolvedValue({
      id: 12,
      user_id: 1,
      operator_user_id: 1,
      operator_username: "operator",
      organization: "TV",
      start_time: "2026-10-08T12:00:00.000Z",
      end_time: null,
      last_update: "2026-10-08T12:00:00.000Z",
      status: "active",
    });

    const response = await fetch(`${baseUrl}/api/sessions/current`);
    const body = await response.json() as { session: { organization: string } };

    expect(response.status).toBe(200);
    expect(body.session.organization).toBe("TV");
  });
});