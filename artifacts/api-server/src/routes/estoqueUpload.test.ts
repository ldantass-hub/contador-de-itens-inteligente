import cookieParser from "cookie-parser";
import ExcelJS from "exceljs";
import express from "express";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMulterError } from "../middlewares/handleMulterError.js";

const state = vi.hoisted(() => ({
  getAuthUserById: vi.fn(),
  appendIgnoredLog: vi.fn(),
  getSessionCounts: vi.fn(),
  getActiveSession: vi.fn(),
  getSessionById: vi.fn(),
  saveAndFinalizeSession: vi.fn(),
}));

vi.mock("../lib/db.js", () => state);

const SECRET = "upload-test-secret-with-at-least-32-characters";
const USER = { id: 42, username: "uploader", role: "user", authVersion: 1 };
let server: ReturnType<express.Express["listen"]>;
let baseUrl: string;
let token: string;
let normalXlsx: Buffer;

interface ZipFixtureEntry {
  name: string;
  content: Buffer;
}

function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localRecords.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralRecords.push(central);
    localOffset += local.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const localData = Buffer.concat(localRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralDirectory, end]);
}

function oversizedWorksheetXlsx(): Buffer {
  const rows: string[] = [];
  for (let rowNumber = 1; rowNumber <= 50_002; rowNumber++) {
    rows.push(`<row r="${rowNumber}"><c r="A${rowNumber}"><v>x</v></c></row>`);
  }

  return zipFixture([
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    {
      name: "xl/workbook.xml",
      content: Buffer.from('<workbook xmlns:r="urn:r"><sheets><sheet r:id="rId1"/></sheets></workbook>'),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: Buffer.from(`<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`),
    },
  ]);
}

function createForm(files: Array<{ field: string; buffer: Buffer; name: string; type: string }>, fields: Array<[string, string]> = []): FormData {
  const form = new FormData();
  for (const file of files) {
    const bytes = new Uint8Array(file.buffer.length);
    bytes.set(file.buffer);
    form.append(file.field, new Blob([bytes], { type: file.type }), file.name);
  }
  for (const [name, value] of fields) form.append(name, value);
  return form;
}

async function postUpload(form: FormData): Promise<Response> {
  return fetch(`${baseUrl}/api/estoque/upload`, {
    method: "POST",
    headers: { Cookie: `access_token=${token}` },
    body: form,
  });
}

function uploadedFile(buffer = normalXlsx, name = "inventory.xlsx", type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
  return { field: "planilha", buffer, name, type };
}

async function createWorkbook(
  sheets: Array<{ name: string; rows: Array<Array<string | number | null>> }>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const { name, rows } of sheets) {
    const worksheet = workbook.addWorksheet(name);
    for (const row of rows) worksheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function getJson(path: string): Promise<{ response: Response; data: unknown }> {
  const response = await fetch(`${baseUrl}/api/estoque${path}`, {
    headers: { Cookie: `access_token=${token}` },
  });
  return { response, data: await response.json() as unknown };
}

describe("POST /api/estoque/upload", () => {
  beforeAll(async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();

    const [{ default: estoqueRouter }, { signToken }] = await Promise.all([
      import("./estoque.js"),
      import("../lib/jwtUtils.js"),
    ]);
    token = signToken({
      userId: USER.id,
      username: USER.username,
      role: USER.role,
      authVersion: USER.authVersion,
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Referência");
    worksheet.addRow(["ITEM", "QUANTIDADE"]);
    worksheet.addRow(["ABCDEFGHIJK", 7]);
    normalXlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    const app = express();
    app.use(cookieParser());
    app.use("/api/estoque", estoqueRouter);
    app.use(handleMulterError);
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Erro interno do servidor." });
    });

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    for (const mock of Object.values(state)) mock.mockReset();
    state.getAuthUserById.mockResolvedValue(USER);
    state.getActiveSession.mockResolvedValue({
      id: 91,
      user_id: USER.id,
      operator_user_id: USER.id,
      operator_username: USER.username,
      organization: "TV/PC",
      start_time: "2026-10-04T00:00:00.000Z",
      end_time: null,
      last_update: "2026-10-04T00:00:00.000Z",
      status: "active",
    });
    state.getSessionCounts.mockResolvedValue([]);
    state.getSessionById.mockResolvedValue(undefined);
    state.saveAndFinalizeSession.mockResolvedValue("saved");
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    vi.unstubAllEnvs();
  });

  it("accepts FormData containing only the planilha file and preserves the import response", async () => {
    const response = await postUpload(createForm([uploadedFile()]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rows: 1 });
  });

  it("returns 413 when the uploaded file exceeds 5 MiB", async () => {
    const file = Buffer.alloc(5 * 1024 * 1024 + 1, 0x41);
    const response = await postUpload(createForm([uploadedFile(file)]));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Arquivo excede o limite permitido." });
  });

  it("rejects a textual multipart field with HTTP 400", async () => {
    const response = await postUpload(createForm([uploadedFile()], [["note", "extra"]]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Requisição de upload inválida." });
  });

  it("rejects a second file with HTTP 400", async () => {
    const response = await postUpload(createForm([
      uploadedFile(),
      uploadedFile(normalXlsx, "second.xlsx"),
    ]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Requisição de upload inválida." });
  });

  it.each([
    ["empty file", Buffer.alloc(0), "inventory.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["short magic header", Buffer.from([0x50, 0x4b, 0x03]), "inventory.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["wrong extension", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "inventory.xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["wrong MIME type", Buffer.from([0x50, 0x4b, 0x03, 0x04]), "inventory.xlsx", "application/octet-stream"],
  ])("rejects %s with HTTP 400", async (_description, buffer, name, type) => {
    const response = await postUpload(createForm([uploadedFile(buffer as Buffer, name as string, type as string)]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Envie um arquivo Excel .xlsx válido." });
  });

  it("rejects a ZIP signature with invalid ZIP structure", async () => {
    const invalidZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const response = await postUpload(createForm([uploadedFile(invalidZip)]));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Planilha inválida ou corrompida." });
  });

  it("rejects a corrupted XLSX before calling ExcelJS load", async () => {
    const corrupted = Buffer.from(normalXlsx);
    corrupted.writeUInt32LE(0, 0);
    const xlsxPrototype = new ExcelJS.Workbook().xlsx.constructor.prototype as { load: (...args: unknown[]) => Promise<unknown> };
    const loadSpy = vi.spyOn(xlsxPrototype, "load");

    const response = await postUpload(createForm([uploadedFile(corrupted)]));

    expect(response.status).toBe(400);
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it("rejects a worksheet above 50,000 data rows before calling ExcelJS load", async () => {
    const oversized = oversizedWorksheetXlsx();
    const xlsxPrototype = new ExcelJS.Workbook().xlsx.constructor.prototype as { load: (...args: unknown[]) => Promise<unknown> };
    const loadSpy = vi.spyOn(xlsxPrototype, "load");

    const response = await postUpload(createForm([uploadedFile(oversized)]));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Planilha excede os limites permitidos." });
    expect(loadSpy).not.toHaveBeenCalled();
    loadSpy.mockRestore();
  });

  it("imports values from only the first worksheet using the current positional conversion rules", async () => {
    const workbook = await createWorkbook([
      {
        name: "Primeira",
        rows: [
          ["ITEM", "QUANTIDADE"],
          ["  aBc  ", 5],
          ["ABC", "8"],
          ["", 100],
          ["NaN", "not-a-number"],
          ["Positive Infinity", "Infinity"],
          ["Negative Infinity", "-Infinity"],
          ["Null quantity", null],
          ["Blank quantity", ""],
          ["Zero", 0],
          ["Negative", -2],
          ["Fraction", "1.5"],
          ["Total Geral", 17],
        ],
      },
      {
        name: "Segunda",
        rows: [
          ["ITEM", "QUANTIDADE"],
          ["SECOND WORKSHEET", 999],
        ],
      },
    ]);
    const response = await postUpload(createForm([uploadedFile(workbook)]));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rows: 7 });

    const preview = await getJson("/preview-exportar");
    expect(preview.response.status).toBe(200);
    expect(preview.data).toEqual({
      hasComparison: true,
      organization: "TV/PC",
      rows: [
        { code: "ABC", quantity: 0, esperado: 8, diferenca: -8, sinal: "-" },
        { code: "BLANK QUANTITY", quantity: 0, esperado: 0, diferenca: 0, sinal: "=" },
        { code: "FRACTION", quantity: 0, esperado: 1.5, diferenca: -1.5, sinal: "-" },
        { code: "NEGATIVE", quantity: 0, esperado: -2, diferenca: 2, sinal: "+" },
        { code: "NULL QUANTITY", quantity: 0, esperado: 0, diferenca: 0, sinal: "=" },
        { code: "TOTAL GERAL", quantity: 0, esperado: 17, diferenca: -17, sinal: "-" },
        { code: "ZERO", quantity: 0, esperado: 0, diferenca: 0, sinal: "=" },
      ],
    });
  });

  it("returns comparison rows for the union of normalized Excel and session codes", async () => {
    const workbook = await createWorkbook([{
      name: "Referência",
      rows: [
        ["ITEM", "QUANTIDADE"],
        [" both ", 5],
        [" item-z ", 10],
        ["only excel", 9],
        ["same", 0],
        ["zero-count", 3],
        ["minus", 8],
      ],
    }]);
    const upload = await postUpload(createForm([uploadedFile(workbook)]));
    expect(upload.status).toBe(200);
    state.getSessionCounts.mockResolvedValue([
      { code: "BOTH", quantity: 7 },
      { code: "count only", quantity: 4 },
      { code: "ITEM-Z", quantity: 10 },
      { code: "same", quantity: 0 },
      { code: "zero-count", quantity: 0 },
      { code: "minus", quantity: 1 },
    ]);

    const comparison = await getJson("/comparar");

    expect(comparison.response.status).toBe(200);
    expect(comparison.data).toEqual([
      { item: "BOTH", contado: 7, esperado: 5, diferenca: 2, sinal: "+" },
      { item: "COUNT ONLY", contado: 4, esperado: 0, diferenca: 4, sinal: "+" },
      { item: "ITEM-Z", contado: 10, esperado: 10, diferenca: 0, sinal: "=" },
      { item: "MINUS", contado: 1, esperado: 8, diferenca: -7, sinal: "-" },
      { item: "ONLY EXCEL", contado: 0, esperado: 9, diferenca: -9, sinal: "-" },
      { item: "SAME", contado: 0, esperado: 0, diferenca: 0, sinal: "=" },
      { item: "ZERO-COUNT", contado: 0, esperado: 3, diferenca: -3, sinal: "-" },
    ]);
    expect(state.getSessionCounts).toHaveBeenCalledWith(91);
  });

  it("returns a 400 response when comparing without a nonempty imported workbook", async () => {
    const workbook = await createWorkbook([{
      name: "Referência",
      rows: [["ITEM", "QUANTIDADE"]],
    }]);
    const upload = await postUpload(createForm([uploadedFile(workbook)]));
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({ ok: true, rows: 0 });

    const comparison = await getJson("/comparar");

    expect(comparison.response.status).toBe(400);
    expect(comparison.data).toEqual({ error: "Nenhuma planilha importada." });
    expect(state.getSessionCounts).not.toHaveBeenCalled();
  });

  it("includes counted, expected, difference, and sign fields in the comparison preview", async () => {
    const workbook = await createWorkbook([{
      name: "Referência",
      rows: [["ITEM", "QUANTIDADE"], ["match", 4], ["excel only", 7]],
    }]);
    const upload = await postUpload(createForm([uploadedFile(workbook)]));
    expect(upload.status).toBe(200);
    state.getSessionCounts.mockResolvedValue([
      { code: "MATCH", quantity: 6 },
      { code: "count only", quantity: 3 },
    ]);

    const preview = await getJson("/preview-exportar");

    expect(preview.response.status).toBe(200);
    expect(preview.data).toEqual({
      hasComparison: true,
      organization: "TV/PC",
      rows: [
        { code: "COUNT ONLY", quantity: 3, esperado: 0, diferenca: 3, sinal: "+" },
        { code: "EXCEL ONLY", quantity: 0, esperado: 7, diferenca: -7, sinal: "-" },
        { code: "MATCH", quantity: 6, esperado: 4, diferenca: 2, sinal: "+" },
      ],
    });
  });

  it("previews counts without comparison columns when no workbook has been imported", async () => {
    const workbook = await createWorkbook([{
      name: "Referência",
      rows: [["ITEM", "QUANTIDADE"]],
    }]);
    const upload = await postUpload(createForm([uploadedFile(workbook)]));
    expect(upload.status).toBe(200);
    state.getSessionCounts.mockResolvedValue([{ code: "COUNT ONLY", quantity: 3 }]);

    const preview = await getJson("/preview-exportar");

    expect(preview.response.status).toBe(200);
    expect(preview.data).toEqual({
      hasComparison: false,
      organization: "TV/PC",
      rows: [
        { code: "COUNT ONLY", quantity: 3, esperado: null, diferenca: null, sinal: null },
      ],
    });
  });

  it("exports a valid workbook with the implemented worksheet and column structure", async () => {
    state.getSessionCounts.mockResolvedValue([
      { code: "ABCDEFGHIJK", quantity: 6 },
      { code: "KLMNOPQRSTU", quantity: 2 },
    ]);

    const response = await fetch(`${baseUrl}/api/estoque/exportar`, {
      headers: { Cookie: `access_token=${token}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("content-disposition")).toContain("resultado_sessao.xlsx");

    const workbook = new ExcelJS.Workbook();
    const buffer = Buffer.from(await response.arrayBuffer());
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets.map(worksheet => worksheet.name)).toEqual(["Resultado"]);
    const worksheet = workbook.worksheets[0];
    expect(worksheet.getRow(1).values).toEqual([
      undefined,
      "ORGANIZAÇÃO",
      "ITEM",
      "QUANTIDADE TOTAL",
    ]);
    expect(worksheet.getRow(2).values).toEqual([
      undefined,
      "TV/PC",
      "ABCDEFGHIJK",
      6,
    ]);
    expect(worksheet.getRow(3).values).toEqual([
      undefined,
      "TV/PC",
      "KLMNOPQRSTU",
      2,
    ]);
  });

  it.each(["/comparar", "/preview-exportar", "/exportar"])(
    "returns the existing invalid-session response from %s",
    async (path) => {
      const result = await getJson(`${path}?sessionId=invalid`);

      expect(result.response.status).toBe(400);
      expect(result.data).toEqual({ error: "sessionId inválido." });
    },
  );
});
