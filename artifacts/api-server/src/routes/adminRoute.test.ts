import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { getAllSessions } = vi.hoisted(() => ({
  getAllSessions: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  getAllSessions,
  getSessionById: vi.fn(),
  getSessionCounts: vi.fn(),
  getAllUsers: vi.fn(),
  getSessionOperators: vi.fn(),
  createUser: vi.fn(),
  removeUser: vi.fn(),
  updateUserRole: vi.fn(),
}));

vi.mock("../middlewares/authenticate.js", () => ({
  authenticate: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import adminRouter from "./adminRoute.js";

describe("GET /api/admin/sessions historical organization filter", () => {
  let server: ReturnType<express.Express["listen"]>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use("/api/admin", adminRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("returns historical sessions with their original TV value", async () => {
    getAllSessions.mockResolvedValue([{
      id: 12,
      username: "operator",
      operator_user_id: 1,
      organization: "TV",
      start_time: "2026-10-08T12:00:00.000Z",
      end_time: null,
      last_update: "2026-10-08T12:00:00.000Z",
      status: "finished",
      total_quantity: 4,
    }]);

    const response = await fetch(`${baseUrl}/api/admin/sessions?organization=TV`);
    const body = await response.json() as Array<{ organization: string }>;

    expect(response.status).toBe(200);
    expect(body[0].organization).toBe("TV");
    expect(getAllSessions).toHaveBeenCalledWith(expect.objectContaining({ organization: "TV" }));
  });
});