import { Router } from "express";
import ExcelJS from "exceljs";
import { authenticate, requireAdmin } from "../middlewares/authenticate.js";
import {
  getAllSessions,
  getSessionById,
  getSessionCounts,
  getAllUsers,
  getSessionOperators,
  createUser,
  removeUser,
} from "../lib/db.js";
import { isOrganization, type Organization } from "../lib/organizations.js";
import { parsePostgresId } from "../lib/inputValidation.js";

const router = Router();
router.use(authenticate, requireAdmin);

/* ── GET /api/admin/users ───────────────────────────────────────────────────*/
router.get("/users", async (_req, res) => {
  res.json(await getAllUsers());
});

/* ── POST /api/admin/users ──────────────────────────────────────────────────*/
router.post("/users", async (req, res) => {
  const body = (req.body ?? {}) as {
    username?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (typeof body.username !== "string" || typeof body.password !== "string" || !body.username.trim() || !body.password) {
    res.status(400).json({ error: "Usuário e senha são obrigatórios." });
    return;
  }

  const username = body.username.trim();
  if (username.length < 3 || username.length > 100) {
    res.status(400).json({ error: "O usuário deve ter entre 3 e 100 caracteres." });
    return;
  }

  if (body.password.length < 12) {
    res.status(400).json({ error: "A senha deve ter no mínimo 12 caracteres." });
    return;
  }

  if (body.role !== "user" && body.role !== "admin") {
    res.status(400).json({ error: "O perfil deve ser 'user' ou 'admin'." });
    return;
  }

  try {
    const id = await createUser(username, body.password, body.role);
    res.status(201).json({ user: { id, username, role: body.role } });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (("code" in error && error.code === "23505") ||
        ("cause" in error && typeof error.cause === "object" && error.cause !== null && "code" in error.cause && error.cause.code === "23505"))
    ) {
      res.status(409).json({ error: "Esse usuário já existe." });
      return;
    }
    res.status(500).json({ error: "Não foi possível criar o usuário." });
  }
});

router.delete("/users/:userId", async (req, res) => {
  const userId = parsePostgresId(req.params.userId);
  if (userId === null) {
    res.status(400).json({ error: "ID de usuário inválido." });
    return;
  }

  try {
    const result = await removeUser(userId, req.user!.userId);
    if (result === "not_found") {
      res.status(404).json({ error: "Usuário não encontrado." });
      return;
    }
    if (result === "self") {
      res.status(409).json({ error: "Você não pode remover sua própria conta." });
      return;
    }
    res.json({ message: "Usuário removido com sucesso." });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
    if (code === "23503") {
      res.status(409).json({ error: "Não foi possível remover o usuário por uma referência ainda existente." });
      return;
    }
    res.status(500).json({ error: "Não foi possível remover o usuário." });
  }
});

/* ── GET /api/admin/sessions ────────────────────────────────────────────────
   Query params: userId, status, organization, dateFrom, dateTo
   MEDIUM FIX — validate all numeric/string inputs before passing to DB layer.
*/
router.get("/sessions", async (req, res) => {
  const { userId, status, organization, dateFrom, dateTo } = req.query as Record<string, string>;

  const parsedUserId = userId ? Number(userId) : undefined;
  if (userId && (!Number.isFinite(parsedUserId) || parsedUserId! <= 0)) {
    res.status(400).json({ error: "Parâmetro 'userId' inválido." });
    return;
  }

  /* Whitelist allowed status values */
  const validStatuses = ["active", "finished"] as const;
  if (status && !validStatuses.includes(status as typeof validStatuses[number])) {
    res.status(400).json({ error: "Parâmetro 'status' inválido." });
    return;
  }

  if (organization && !isOrganization(organization)) {
    res.status(400).json({ error: "Parâmetro 'organization' inválido." });
    return;
  }

  /* Basic ISO-date format check — YYYY-MM-DD */
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (dateFrom && !datePattern.test(dateFrom)) {
    res.status(400).json({ error: "Parâmetro 'dateFrom' deve ser no formato YYYY-MM-DD." });
    return;
  }
  if (dateTo && !datePattern.test(dateTo)) {
    res.status(400).json({ error: "Parâmetro 'dateTo' deve ser no formato YYYY-MM-DD." });
    return;
  }

  const sessions = await getAllSessions({
    userId:   parsedUserId,
    status:   status   || undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo   || undefined,
    organization: organization as Organization | undefined,
  });
  res.json(sessions);
});

router.get("/session-operators", async (_req, res) => {
  res.json(await getSessionOperators());
});

/* ── GET /api/admin/sessions/:id ────────────────────────────────────────────
   MEDIUM FIX — validate :id is a positive integer before DB lookup.
*/
router.get("/sessions/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    res.status(400).json({ error: "ID de sessão inválido." });
    return;
  }

  const session = await getSessionById(id);
  if (!session) {
    res.status(404).json({ error: "Sessão não encontrada." });
    return;
  }
  const counts = await getSessionCounts(id);
  res.json({ session, counts });
});

/* ── GET /api/admin/sessions/:id/export ─────────────────────────────────────
   MEDIUM FIX — same :id validation as above.
*/
router.get("/sessions/:id/export", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0 || !Number.isInteger(id)) {
    res.status(400).json({ error: "ID de sessão inválido." });
    return;
  }

  const session = await getSessionById(id);
  if (!session) {
    res.status(404).json({ error: "Sessão não encontrada." });
    return;
  }
  const counts = await getSessionCounts(id);

  const wb    = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Sessão");
  sheet.columns = [
    { header: "OPERADOR",    key: "operator",    width: 24 },
    { header: "ORGANIZAÇÃO", key: "organization", width: 16 },
    { header: "ITEM",       key: "code",     width: 24 },
    { header: "QUANTIDADE", key: "quantity",  width: 16 },
  ];
  sheet.getRow(1).font      = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  sheet.getRow(1).alignment = { horizontal: "center" };
  counts.forEach(c => sheet.addRow({
    operator: session.operator_username,
    organization: session.organization ?? "Não informada",
    code: c.code,
    quantity: c.quantity,
  }));

  const filename = `sessao_${id}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
