import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import {
  getActiveSession,
  selectOrganizationSession,
  finalizeSession,
  updateSessionPing,
  getSessionById,
  saveSessionCount,
  saveAndFinalizeSession,
  appendIgnoredLog,
} from "../lib/db.js";
import { isOrganization, type Organization } from "../lib/organizations.js";

const router = Router();
router.use(authenticate);

/* ── POST /api/sessions/select-organization ─────────────────────────────────
   Assigns the selected organization to the active legacy session or creates
   the new session after login. An active session cannot be moved to another
   organization.
*/
router.post("/select-organization", (req, res) => {
  const organization = (req.body as { organization?: unknown }).organization;
  if (!isOrganization(organization)) {
    res.status(400).json({ error: "Selecione uma organização válida." });
    return;
  }

  const selection = selectOrganizationSession(req.user!.userId, organization);
  if (selection.kind === "conflict") {
    res.status(409).json({
      error: `A sessão ativa pertence à organização ${selection.session.organization}. Finalize-a antes de iniciar outra organização.`,
    });
    return;
  }

  res.json({ session: selection.session });
});

/* ── POST /api/sessions/resume ──────────────────────────────────────────────
   Body: { action: "resume" | "new", organization? }
   Returns the session to use.
*/
router.post("/resume", (req, res) => {
  const userId = req.user!.userId;
  const body = req.body as { action?: string; organization?: unknown };
  const action = body.action;

  if (action !== "resume" && action !== "new") {
    res.status(400).json({ error: "action deve ser 'resume' ou 'new'." });
    return;
  }

  const existing = getActiveSession(userId);

  if (action === "resume" && existing) {
    res.json({ session: existing });
    return;
  }

  /* An existing active session cannot be replaced with another organization. */
  if (existing) {
    if (action === "new") {
      res.status(409).json({
        error: "Finalize a sessão atual antes de iniciar uma nova organização.",
      });
      return;
    }
    res.status(409).json({ error: "A sessão ativa não pode ser alterada." });
    return;
  }

  const organization = body.organization;
  if (organization !== undefined && !isOrganization(organization)) {
    res.status(400).json({ error: "Organização inválida." });
    return;
  }

  const session = createSession(userId, (organization ?? null) as Organization | null);
  res.json({ session });
});

/* ── GET /api/sessions/current ──────────────────────────────────────────────
   Returns the active session for the authenticated user.
*/
router.get("/current", (req, res) => {
  const session = getActiveSession(req.user!.userId);
  if (!session) {
    res.status(404).json({ error: "Nenhuma sessão ativa." });
    return;
  }
  res.json({ session });
});

/* ── PUT /api/sessions/ping ─────────────────────────────────────────────────
   Updates last_update for the user's active session.
*/
router.put("/ping", (req, res) => {
  const session = getActiveSession(req.user!.userId);
  if (!session) {
    res.status(404).json({ error: "Nenhuma sessão ativa." });
    return;
  }
  updateSessionPing(session.id);
  res.json({ ok: true });
});

/* ── POST /api/sessions/encerrar ─────────────────────────────────────────────
   Ends the current session so the user can start a new organization.
*/
router.post("/encerrar", (req, res) => {
  const session = getActiveSession(req.user!.userId);
  if (!session) {
    res.status(404).json({ error: "Nenhuma sessão ativa." });
    return;
  }

  finalizeSession(session.id);
  res.json({ ok: true, sessionId: session.id });
});

/* ── POST /api/sessions/salvar ──────────────────────────────────────────────
   Body: { sessionId, codigo, total, ignoredLogs? }
   Saves (upserts) the count for one item WITHOUT finalizing the session.
*/
router.post("/salvar", (req, res) => {
  const { sessionId, codigo, total, ignoredLogs } = req.body as {
    sessionId?: number;
    codigo?: string;
    total?: number;
    ignoredLogs?: string[];
  };

  if (!sessionId) {
    res.status(400).json({ error: "sessionId é obrigatório." });
    return;
  }
  if (!codigo || typeof codigo !== "string") {
    res.status(400).json({ error: "Campo 'codigo' é obrigatório." });
    return;
  }
  const qty = Number(total);
  if (!Number.isFinite(qty) || qty < 0) {
    res.status(400).json({ error: "Campo 'total' deve ser um número não-negativo." });
    return;
  }

  const session = getSessionById(sessionId);
  if (!session || session.user_id !== req.user!.userId) {
    res.status(403).json({ error: "Sessão inválida." });
    return;
  }
  if (session.status === "finished") {
    res.status(400).json({ error: "Sessão já foi finalizada." });
    return;
  }

  const writeResult = saveSessionCount(sessionId, req.user!.userId, codigo, qty);
  if (writeResult !== "saved") {
    res.status(writeResult === "forbidden" ? 403 : 400).json({
      error: writeResult === "finished" ? "Sessão já foi finalizada." : "Sessão inválida.",
    });
    return;
  }
  if (Array.isArray(ignoredLogs) && ignoredLogs.length > 0) {
    appendIgnoredLog(ignoredLogs);
  }

  res.json({ ok: true, codigo, savedQuantity: qty });
});

/* ── POST /api/sessions/finalizar ───────────────────────────────────────────
   Body: { sessionId, codigo, total, ignoredLogs? }
   Saves counts, finalizes session.
*/
router.post("/finalizar", (req, res) => {
  const { sessionId, codigo, total, ignoredLogs } = req.body as {
    sessionId?: number;
    codigo?: string;
    total?: number;
    ignoredLogs?: string[];
  };

  if (!sessionId) {
    res.status(400).json({ error: "sessionId é obrigatório." });
    return;
  }
  if (!codigo || typeof codigo !== "string") {
    res.status(400).json({ error: "Campo 'codigo' é obrigatório." });
    return;
  }
  const qty = Number(total);
  if (!Number.isFinite(qty) || qty < 0) {
    res.status(400).json({ error: "Campo 'total' deve ser um número não-negativo." });
    return;
  }

  const session = getSessionById(sessionId);
  if (!session || session.user_id !== req.user!.userId) {
    res.status(403).json({ error: "Sessão inválida." });
    return;
  }
  if (session.status === "finished") {
    res.status(400).json({ error: "Sessão já foi finalizada." });
    return;
  }

  const writeResult = saveAndFinalizeSession(sessionId, req.user!.userId, codigo, qty);
  if (writeResult !== "saved") {
    res.status(writeResult === "forbidden" ? 403 : 400).json({
      error: writeResult === "finished" ? "Sessão já foi finalizada." : "Sessão inválida.",
    });
    return;
  }
  if (Array.isArray(ignoredLogs) && ignoredLogs.length > 0) {
    appendIgnoredLog(ignoredLogs);
  }

  res.json({ ok: true, codigo, savedQuantity: qty });
});

export default router;
