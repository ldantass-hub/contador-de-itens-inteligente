import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { authenticate } from "../middlewares/authenticate.js";
import {
  appendIgnoredLog,
  getSessionCounts,
  getActiveSession,
  getSessionById,
  saveAndFinalizeSession,
} from "../lib/db.js";
import { parsePostgresQuantity } from "../lib/inputValidation.js";

const router = Router();
router.use(authenticate);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, /* 5 MB cap — prevent memory exhaustion */
});
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function isXlsxUpload(file: Express.Multer.File): boolean {
  return file.originalname.toLowerCase().endsWith(".xlsx") &&
    file.mimetype.toLowerCase() === XLSX_MIME_TYPE &&
    file.buffer.length >= 4 &&
    file.buffer[0] === 0x50 && file.buffer[1] === 0x4b &&
    file.buffer[2] === 0x03 && file.buffer[3] === 0x04;
}

function isWorkbookFormatError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /can't find end of central directory|corrupted zip|end of data reached|^\d+:\d+:\s*(?:unexpected|invalid|expected)\b/i.test(error.message);
}

/*
 * C1 FIX — Per-session Excel store
 *
 * Reference spreadsheets belong to an inventory session, not to a user.
 * Otherwise a second organization session from the same user could compare
 * against the previous organization's file.
 *
 * Entries are bounded by TTL and count because this is temporary comparison
 * state, not the source of truth for session counts.
 */
const EXCEL_STORE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EXCEL_STORES = 256;
const excelDataBySession = new Map<number, {
  data: Map<string, number>;
  lastUsedAt: number;
}>();

function pruneExcelStores(now = Date.now()): void {
  for (const [sessionId, store] of excelDataBySession) {
    if (now - store.lastUsedAt > EXCEL_STORE_TTL_MS) {
      excelDataBySession.delete(sessionId);
    }
  }
  while (excelDataBySession.size > MAX_EXCEL_STORES) {
    const oldest = [...excelDataBySession.entries()]
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!oldest) break;
    excelDataBySession.delete(oldest[0]);
  }
}

async function getSessionForUser(
  userId: number,
  rawSessionId: unknown,
): Promise<{ session: Awaited<ReturnType<typeof getSessionById>>; error?: string; status?: number }> {
  if (rawSessionId !== undefined) {
    const sessionId = Number(rawSessionId);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return { session: undefined, error: "sessionId inválido.", status: 400 };
    }
    const session = await getSessionById(sessionId);
    if (!session || session.user_id !== userId) {
      return { session: undefined, error: "Sessão inválida.", status: 403 };
    }
    return { session };
  }

  const session = await getActiveSession(userId);
  if (!session) {
    return { session: undefined, error: "Nenhuma sessão ativa.", status: 400 };
  }
  return { session };
}

/* ── POST /api/estoque/finalizar ─────────────────────────────────────────────
   Legacy endpoint kept for older clients. It now writes only to the
   authenticated user's active session instead of the global legacy table.
*/
router.post("/finalizar", async (req, res) => {
  const { codigo, total, ignoredLogs } = req.body as {
    codigo: string;
    total: number;
    ignoredLogs?: string[];
  };

  if (!codigo || typeof codigo !== "string") {
    res.status(400).json({ error: "Campo 'codigo' é obrigatório." });
    return;
  }
  const qty = parsePostgresQuantity(total);
  if (qty === null) {
    res.status(400).json({ error: "Campo 'total' deve ser um número inteiro entre 0 e 2147483647." });
    return;
  }
  const session = await getActiveSession(req.user!.userId);
  if (!session) {
    res.status(409).json({ error: "Nenhuma sessão ativa para finalizar." });
    return;
  }

  const result = await saveAndFinalizeSession(session.id, req.user!.userId, codigo, qty);
  if (result !== "saved") {
    res.status(result === "forbidden" ? 403 : 400).json({ error: "Sessão inválida ou já finalizada." });
    return;
  }
  if (Array.isArray(ignoredLogs) && ignoredLogs.length > 0) {
    appendIgnoredLog(ignoredLogs);
  }
  res.json({ ok: true, codigo, savedQuantity: qty, sessionId: session.id });
});

/* ── GET /api/estoque/itens ──────────────────────────────────────────────── */
router.get("/itens", async (req, res) => {
  const session = await getActiveSession(req.user!.userId);
  if (!session) {
    res.status(400).json({ error: "Nenhuma sessão ativa." });
    return;
  }
  const sessionCounts = await getSessionCounts(session.id);
  res.json(sessionCounts.map((item, index) => ({
    id: index + 1,
    codigo: item.code,
    quantidade: item.quantity,
  })));
});

/* ── POST /api/estoque/upload ────────────────────────────────────────────── */
router.post("/upload", upload.single("planilha"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "Nenhum arquivo enviado." });
    return;
  }
  if (!isXlsxUpload(req.file)) {
    res.status(400).json({ error: "Envie um arquivo Excel .xlsx válido." });
    return;
  }
  const session = await getActiveSession(req.user!.userId);
  if (!session) {
    res.status(409).json({ error: "Inicie uma sessão antes de importar uma planilha." });
    return;
  }
  try {
    const wb = new ExcelJS.Workbook();
     const workbookBuffer = req.file.buffer as unknown as Parameters<typeof wb.xlsx.load>[0];
    await wb.xlsx.load(workbookBuffer);
    const sheet = wb.worksheets[0];
    if (!sheet) {
      res.status(400).json({ error: "Planilha vazia ou inválida." });
      return;
    }

    /* Build a fresh store for this user — replaces any previous upload */
    const store = new Map<string, number>();
    sheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; /* skip header */
      const rawCodigo = row.getCell(1).value;
      const rawQty    = row.getCell(2).value;
      const codigo    = String(rawCodigo ?? "").trim();
      const qty       = Number(rawQty);
      if (codigo && Number.isFinite(qty)) {
        store.set(codigo.toUpperCase(), qty);
      }
    });

    /* Atomic replace — no partial state exposed to concurrent requests */
    pruneExcelStores();
    excelDataBySession.set(session.id, { data: store, lastUsedAt: Date.now() });
    pruneExcelStores();

    res.json({ ok: true, rows: store.size });
  } catch (error) {
    if (isWorkbookFormatError(error)) {
      res.status(400).json({ error: "Planilha inválida ou corrompida." });
      return;
    }
    throw error;
  }
});

/* ── GET /api/estoque/comparar ───────────────────────────────────────────────
   Compares the user's session counts vs their own imported Excel data.
*/
router.get("/comparar", authenticate, async (req, res) => {
  const resolved = await getSessionForUser(req.user!.userId, req.query.sessionId);
  if (!resolved.session) {
    res.status(resolved.status ?? 400).json({ error: resolved.error ?? "Sessão inválida." });
    return;
  }
  const session = resolved.session;
  const sessionId = session.id;
  pruneExcelStores();
  const entry = excelDataBySession.get(sessionId);
  if (!entry || entry.data.size === 0) {
    if (entry) entry.lastUsedAt = Date.now();
    res.status(400).json({ error: "Nenhuma planilha importada." });
    return;
  }
  entry.lastUsedAt = Date.now();
  const userStore = entry.data;

  const sessionCounts = await getSessionCounts(sessionId);
  const countMap      = new Map(sessionCounts.map(c => [c.code.toUpperCase(), c.quantity]));
  const allCodes      = new Set([...countMap.keys(), ...userStore.keys()]);

  const rows = Array.from(allCodes)
    .sort()
    .map(code => {
      const contado   = countMap.get(code) ?? 0;
      const esperado  = userStore.get(code) ?? 0;
      const diferenca = contado - esperado;
      return {
        item: code,
        contado,
        esperado,
        diferenca,
        sinal: diferenca > 0 ? "+" : diferenca < 0 ? "-" : "=",
      };
    });

  res.json(rows);
});

/* ── GET /api/estoque/preview-exportar ──────────────────────────────────────
   Returns export data as JSON for the preview modal.
   Comparison columns are added if the user has imported a sheet.
*/
router.get("/preview-exportar", authenticate, async (req, res) => {
  const resolved = await getSessionForUser(req.user!.userId, req.query.sessionId);
  if (!resolved.session) {
    res.status(resolved.status ?? 400).json({ error: resolved.error ?? "Sessão inválida." });
    return;
  }
  const session = resolved.session;
  const sessionId = session.id;
  const counts = await getSessionCounts(sessionId);
  pruneExcelStores();
  const entry = excelDataBySession.get(sessionId);
  const userStore = entry?.data;

  if (!userStore || userStore.size === 0) {
    res.json({
      hasComparison: false,
      organization: session?.organization ?? null,
      rows: counts.map(c => ({
        code:      c.code,
        quantity:  c.quantity,
        esperado:  null as null,
        diferenca: null as null,
        sinal:     null as null,
      })),
    });
    return;
  }
  entry.lastUsedAt = Date.now();

  const countMap = new Map(counts.map(c => [c.code.toUpperCase(), c.quantity]));
  const allCodes = new Set([...countMap.keys(), ...userStore.keys()]);
  const rows = Array.from(allCodes).sort().map(code => {
    const contado   = countMap.get(code) ?? 0;
    const esperado  = userStore.get(code) ?? 0;
    const diferenca = contado - esperado;
    return {
      code,
      quantity:  contado,
      esperado,
      diferenca,
      sinal: diferenca > 0 ? "+" : diferenca < 0 ? "-" : "=",
    };
  });

  res.json({ hasComparison: true, organization: session?.organization ?? null, rows });
});

/* ── GET /api/estoque/exportar ───────────────────────────────────────────────
   Exports session counts to Excel.
*/
router.get("/exportar", authenticate, async (req, res) => {
  const resolved = await getSessionForUser(req.user!.userId, req.query.sessionId);
  if (!resolved.session) {
    res.status(resolved.status ?? 400).json({ error: resolved.error ?? "Sessão inválida." });
    return;
  }
  const session = resolved.session;
  const sessionId = session.id;
  const items = await getSessionCounts(sessionId);

  const wb    = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Resultado");
  sheet.columns = [
    { header: "ORGANIZAÇÃO",       key: "organization", width: 16 },
    { header: "ITEM",             key: "code",     width: 24 },
    { header: "QUANTIDADE TOTAL", key: "quantity",  width: 20 },
  ];
  sheet.getRow(1).font      = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  sheet.getRow(1).alignment = { horizontal: "center" };
  items.forEach(item => sheet.addRow({
    organization: session?.organization ?? "Não informada",
    code: item.code,
    quantity: item.quantity,
  }));

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="resultado_sessao.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

export default router;
