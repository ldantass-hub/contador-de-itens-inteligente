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
      organization: "PC",
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
});
