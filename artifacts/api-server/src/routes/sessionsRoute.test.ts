import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  getActiveSession: vi.fn(),
  createSession: vi.fn(),
  selectOrganizationSession: vi.fn(),
  finalizeSession: vi.fn(),
  updateSessionPing: vi.fn(),
  getSessionById: vi.fn(),
  saveSessionCount: vi.fn(),
  saveAndFinalizeSession: vi.fn(),
  appendIgnoredLog: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  getActiveSession: state.getActiveSession,
  createSession: state.createSession,
  selectOrganizationSession: state.selectOrganizationSession,
  finalizeSession: state.finalizeSession,
  updateSessionPing: state.updateSessionPing,
  getSessionById: state.getSessionById,
  saveSessionCount: state.saveSessionCount,
  saveAndFinalizeSession: state.saveAndFinalizeSession,
  appendIgnoredLog: state.appendIgnoredLog,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: state.logInfo, warn: state.logWarn },
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
    app.use(express.json());
    app.use("/api/sessions", sessionsRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server failed to bind.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    for (const mock of Object.values(state)) mock.mockReset();
    state.getActiveSession.mockResolvedValue(undefined);
    state.finalizeSession.mockResolvedValue(false);
    state.saveSessionCount.mockResolvedValue("saved");
    state.saveAndFinalizeSession.mockResolvedValue("saved");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("returns a historical TV session unchanged", async () => {
    state.getActiveSession.mockResolvedValue({
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

  it("starts a session and emits successful session.start only when selection creates one", async () => {
    const session = {
      id: 18,
      user_id: 1,
      operator_user_id: 1,
      operator_username: "operator",
      organization: "TV/PC",
      start_time: "2026-10-09T12:00:00.000Z",
      end_time: null,
      last_update: "2026-10-09T12:00:00.000Z",
      status: "active",
    };
    state.selectOrganizationSession.mockResolvedValue({ kind: "selected", session, created: true });

    const response = await fetch(`${baseUrl}/api/sessions/select-organization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: "TV/PC" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session });
    expect(state.selectOrganizationSession).toHaveBeenCalledWith(1, "TV/PC");
    expect(state.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "success", sessionId: session.id }),
      "Counting session started",
    );
  });

  it("does not emit a successful session.start when an existing session is selected", async () => {
    state.selectOrganizationSession.mockResolvedValue({
      kind: "selected",
      created: false,
      session: { id: 18, organization: "TV/PC" },
    });

    const response = await fetch(`${baseUrl}/api/sessions/select-organization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: "TV/PC" }),
    });

    expect(response.status).toBe(200);
    expect(state.logInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "success" }),
      expect.anything(),
    );
  });

  it("records an organization conflict as a failed start attempt, not a successful start", async () => {
    state.selectOrganizationSession.mockResolvedValue({
      kind: "conflict",
      session: { id: 21, organization: "MEDIA" },
    });

    const response = await fetch(`${baseUrl}/api/sessions/select-organization`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: "TV/PC" }),
    });

    expect(response.status).toBe(409);
    expect(state.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "failure", reason: "organization_conflict" }),
      "Counting session start rejected",
    );
    expect(state.logInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "success" }),
      expect.anything(),
    );
  });

  it("creates a new session on resume action new and emits session.start", async () => {
    const session = { id: 19, organization: "MEDIA", status: "active" };
    state.createSession.mockResolvedValue(session);

    const response = await fetch(`${baseUrl}/api/sessions/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "new", organization: "MEDIA" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session });
    expect(state.createSession).toHaveBeenCalledWith(1, "MEDIA");
    expect(state.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "success", sessionId: session.id }),
      "Counting session started",
    );
  });

  it("resumes an existing session without creating a second session or emitting session.start", async () => {
    const session = { id: 20, organization: "MEDIA", status: "active" };
    state.getActiveSession.mockResolvedValue(session);

    const response = await fetch(`${baseUrl}/api/sessions/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.logInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.start", result: "success" }),
      expect.anything(),
    );
  });

  it("persists a count for the requested owned active session without logging ignored inputs", async () => {
    state.getSessionById.mockResolvedValue({ id: 23, user_id: 1, status: "active" });

    const response = await fetch(`${baseUrl}/api/sessions/salvar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: 23, codigo: "ABCDEFGHIJK", total: 42 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, codigo: "ABCDEFGHIJK", savedQuantity: 42 });
    expect(state.saveSessionCount).toHaveBeenCalledWith(23, 1, "ABCDEFGHIJK", 42);
    expect(state.appendIgnoredLog).not.toHaveBeenCalled();
  });

  it("does not save a count to a session owned by another user", async () => {
    state.getSessionById.mockResolvedValue({ id: 24, user_id: 2, status: "active" });

    const response = await fetch(`${baseUrl}/api/sessions/salvar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: 24, codigo: "ABCDEFGHIJK", total: 42 }),
    });

    expect(response.status).toBe(403);
    expect(state.saveSessionCount).not.toHaveBeenCalled();
  });

  it("associates the submitted count with the owned session before finalizing it", async () => {
    state.getSessionById.mockResolvedValue({ id: 27, user_id: 1, status: "active" });

    const response = await fetch(`${baseUrl}/api/sessions/finalizar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: 27, codigo: "ABCDEFGHIJK", total: 75 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, codigo: "ABCDEFGHIJK", savedQuantity: 75 });
    expect(state.saveAndFinalizeSession).toHaveBeenCalledWith(27, 1, "ABCDEFGHIJK", 75);
    expect(state.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.finish", result: "success", sessionId: 27 }),
      "Counting session finished",
    );
    expect(state.appendIgnoredLog).not.toHaveBeenCalled();
  });

  it("does not emit session.finish when save-and-finalize reports a finished session", async () => {
    state.getSessionById.mockResolvedValue({ id: 28, user_id: 1, status: "active" });
    state.saveAndFinalizeSession.mockResolvedValue("finished");

    const response = await fetch(`${baseUrl}/api/sessions/finalizar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: 28, codigo: "ABCDEFGHIJK", total: 75 }),
    });

    expect(response.status).toBe(400);
    expect(state.logInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.finish", result: "success" }),
      expect.anything(),
    );
  });

  it("emits session.finish only after finalization succeeds", async () => {
    state.getActiveSession.mockResolvedValue({ id: 25, user_id: 1, status: "active" });
    state.finalizeSession.mockResolvedValue(true);

    const response = await fetch(`${baseUrl}/api/sessions/encerrar`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(state.finalizeSession).toHaveBeenCalledWith(25, 1);
    expect(state.logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.finish", result: "success", sessionId: 25 }),
      "Counting session finished",
    );
  });

  it("does not emit session.finish when finalization does not occur", async () => {
    state.getActiveSession.mockResolvedValue({ id: 26, user_id: 1, status: "active" });
    state.finalizeSession.mockResolvedValue(false);

    const response = await fetch(`${baseUrl}/api/sessions/encerrar`, { method: "POST" });

    expect(response.status).toBe(404);
    expect(state.logInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "session.finish", result: "success" }),
      expect.anything(),
    );
  });
});