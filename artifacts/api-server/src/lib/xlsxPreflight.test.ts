import ExcelJS from "exceljs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  preflightXlsx,
  XLSX_PREFLIGHT_LIMITS,
  type XlsxPreflightLimits,
} from "./xlsxPreflight.js";

interface ZipFixtureEntry {
  name: string;
  content: Buffer;
  declaredSize?: number;
}

function zipFixture(entries: ZipFixtureEntry[]): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.content);
    const declaredSize = entry.declaredSize ?? entry.content.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localRecords.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
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

function minimalWorkbookEntries(worksheetXml: string): ZipFixtureEntry[] {
  return [
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    {
      name: "xl/workbook.xml",
      content: Buffer.from('<workbook xmlns:r="urn:r"><sheets><sheet r:id="rId1"/></sheets></workbook>'),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    },
    { name: "xl/worksheets/sheet1.xml", content: Buffer.from(worksheetXml) },
  ];
}

function multiWorksheetEntries(worksheetCount: number): ZipFixtureEntry[] {
  const sheets = Array.from({ length: worksheetCount }, (_, index) =>
    `<sheet name="Sheet${index + 1}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
  ).join("");
  const relationships = Array.from({ length: worksheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");

  return [
    { name: "[Content_Types].xml", content: Buffer.from("<Types/>") },
    {
      name: "xl/workbook.xml",
      content: Buffer.from(`<workbook xmlns:r="urn:r"><sheets>${sheets}</sheets></workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: Buffer.from(`<Relationships>${relationships}</Relationships>`),
    },
    ...Array.from({ length: worksheetCount }, (_, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: Buffer.from(worksheetXml(1)),
    })),
  ];
}

function worksheetXml(dataRows: number, includeEmptyTail = false): string {
  const rows = ['<row r="1"><c r="A1"><v>ITEM</v></c><c r="B1"><v>QUANTIDADE</v></c></row>'];
  for (let rowNumber = 2; rowNumber < dataRows + 2; rowNumber++) {
    rows.push(`<row r="${rowNumber}"><c r="A${rowNumber}"><v>ABCDEFGHIJK</v></c><c r="B${rowNumber}"><v>1</v></c></row>`);
  }
  if (includeEmptyTail) rows.push(`<row r="${dataRows + 2}"><c r="A${dataRows + 2}" s="1"/></row>`);
  return `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

function smallLimits(overrides: Partial<XlsxPreflightLimits>): XlsxPreflightLimits {
  return { ...XLSX_PREFLIGHT_LIMITS, ...overrides };
}

async function validExcelBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Referência");
  worksheet.addRow(["ITEM", "QUANTIDADE"]);
  worksheet.addRow(["ABCDEFGHIJK", 1]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("preflightXlsx", () => {
  it("accepts a normal ExcelJS workbook within the row limit", async () => {
    await expect(preflightXlsx(await validExcelBuffer())).resolves.toBeUndefined();
  });

  it("accepts exactly 16 worksheets", async () => {
    await expect(preflightXlsx(zipFixture(multiWorksheetEntries(16)))).resolves.toBeUndefined();
  });

  it("rejects 17 worksheets", async () => {
    await expect(preflightXlsx(zipFixture(multiWorksheetEntries(17)))).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("does not count an empty trailing worksheet row as a data row", async () => {
    const archive = zipFixture(minimalWorkbookEntries(worksheetXml(2, true)));

    await expect(preflightXlsx(archive, smallLimits({ maxDataRows: 2 }))).resolves.toBeUndefined();
  });

  it("rejects a workbook above the configured data-row limit", async () => {
    const archive = zipFixture(minimalWorkbookEntries(worksheetXml(3)));

    await expect(preflightXlsx(archive, smallLimits({ maxDataRows: 2 }))).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("rejects a worksheet with an excessive sparse row index", async () => {
    const archive = zipFixture(minimalWorkbookEntries('<worksheet><sheetData><row r="99"/></sheetData></worksheet>'));

    await expect(preflightXlsx(archive, smallLimits({ maxRowIndex: 20 }))).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("rejects an archive with more than the maximum number of entries", async () => {
    const entries = minimalWorkbookEntries(worksheetXml(1));
    for (let index = 0; index < XLSX_PREFLIGHT_LIMITS.maxEntries; index++) {
      entries.push({ name: `extra-${index}.bin`, content: Buffer.alloc(0) });
    }
    const archive = zipFixture(entries);

    await expect(preflightXlsx(archive)).rejects.toMatchObject({ statusCode: 413 });
  });

  it("rejects an entry above the per-entry declared limit before inflating it", async () => {
    const entries = minimalWorkbookEntries(worksheetXml(1));
    entries.push({ name: "large.bin", content: Buffer.from("small"), declaredSize: XLSX_PREFLIGHT_LIMITS.maxEntryBytes + 1 });

    await expect(preflightXlsx(zipFixture(entries))).rejects.toMatchObject({ statusCode: 413 });
  });

  it("enforces actual decompressed bytes even when ZIP size metadata understates them", async () => {
    const entries = minimalWorkbookEntries(worksheetXml(1));
    entries.push({ name: "expanded.bin", content: Buffer.alloc(4096, 65), declaredSize: 1 });

    await expect(preflightXlsx(zipFixture(entries), smallLimits({
      maxEntryBytes: 8192,
      maxTotalBytes: 2048,
      maxXmlBytes: 8192,
    }))).rejects.toMatchObject({ statusCode: 413 });
  });

  it("rejects XML tag-like text inside comments without counting it as worksheet rows", async () => {
    const xml = '<worksheet><sheetData><!-- <row r="999"/> --><row r="1"><c r="A1"><v>ITEM</v></c></row></sheetData></worksheet>';
    const archive = zipFixture(minimalWorkbookEntries(xml));

    await expect(preflightXlsx(archive, smallLimits({ maxRowIndex: 10 }))).resolves.toBeUndefined();
  });

  it("rejects a ZIP with invalid local structure", async () => {
    const archive = zipFixture(minimalWorkbookEntries(worksheetXml(1)));
    archive.writeUInt32LE(0, 0);

    await expect(preflightXlsx(archive)).rejects.toMatchObject({ statusCode: 400 });
  });
});
