import { Readable } from "node:stream";
import { createInflateRaw } from "node:zlib";

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_MAX_COMMENT_SIZE = 65_535;
const CHUNK_SIZE = 64 * 1024;

export interface XlsxPreflightLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxXmlBytes: number;
  maxWorksheets: number;
  maxDataRows: number;
  maxRowIndex: number;
  maxCells: number;
}

export const XLSX_PREFLIGHT_LIMITS: Readonly<XlsxPreflightLimits> = {
  maxEntries: 256,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxXmlBytes: 24 * 1024 * 1024,
  maxWorksheets: 16,
  maxDataRows: 50_000,
  maxRowIndex: 50_001,
  maxCells: 100_002,
};

export class XlsxPreflightError extends Error {
  constructor(message: string, readonly statusCode: 400 | 413) {
    super(message);
    this.name = "XlsxPreflightError";
  }
}

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
  isDirectory: boolean;
}

interface PreflightState {
  totalBytes: number;
  xmlBytes: number;
  cells: number;
  readonly limits: XlsxPreflightLimits;
}

interface XmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
}

function invalidWorkbook(): never {
  throw new XlsxPreflightError("Planilha inválida ou corrompida.", 400);
}

function oversizedWorkbook(): never {
  throw new XlsxPreflightError("Planilha excede os limites permitidos.", 413);
}

function hasRange(buffer: Buffer, offset: number, length: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
    offset >= 0 && length >= 0 && offset + length <= buffer.length;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const firstPossibleOffset = Math.max(0, buffer.length - ZIP_EOCD_MIN_SIZE - ZIP_MAX_COMMENT_SIZE);
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(ZIP_EOCD_SIGNATURE);
  const offset = buffer.lastIndexOf(signature);

  if (offset < firstPossibleOffset || !hasRange(buffer, offset, ZIP_EOCD_MIN_SIZE)) {
    return invalidWorkbook();
  }

  const commentLength = buffer.readUInt16LE(offset + 20);
  if (offset + ZIP_EOCD_MIN_SIZE + commentLength !== buffer.length) {
    return invalidWorkbook();
  }
  return offset;
}

function getZipEntries(buffer: Buffer, limits: XlsxPreflightLimits): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== entryCount ||
      entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralSize !== eocdOffset) {
    return invalidWorkbook();
  }
  if (entryCount > limits.maxEntries) return oversizedWorkbook();
  if (!hasRange(buffer, centralOffset, centralSize)) return invalidWorkbook();

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;

  for (let index = 0; index < entryCount; index++) {
    if (!hasRange(buffer, cursor, 46) || buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      return invalidWorkbook();
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;

    if (!hasRange(buffer, cursor, entryLength) || cursor + entryLength > centralEnd ||
        diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
        localOffset === 0xffffffff || (flags & 0x0041) !== 0 || (method !== 0 && method !== 8)) {
      return invalidWorkbook();
    }
    if (uncompressedSize > limits.maxEntryBytes) return oversizedWorkbook();

    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/") ||
        name.split("/").some((part) => part === "..") || names.has(name)) {
      return invalidWorkbook();
    }
    names.add(name);

    if (!hasRange(buffer, localOffset, 30) || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
      return invalidWorkbook();
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method ||
        !hasRange(buffer, localOffset + 30, localNameLength) ||
        buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name ||
        !hasRange(buffer, localOffset, 30 + localNameLength + localExtraLength)) {
      return invalidWorkbook();
    }

    const dataStart = localHeaderEnd;
    const dataEnd = dataStart + compressedSize;
    if (!hasRange(buffer, dataStart, compressedSize) || dataEnd > centralOffset) return invalidWorkbook();

    let recordEnd = dataEnd;
    if ((flags & 0x0008) !== 0) {
      if (!hasRange(buffer, dataEnd, 12)) return invalidWorkbook();
      const hasDescriptorSignature = buffer.readUInt32LE(dataEnd) === ZIP_DESCRIPTOR_SIGNATURE;
      const descriptorOffset = dataEnd + (hasDescriptorSignature ? 4 : 0);
      if (!hasRange(buffer, descriptorOffset, 12) ||
          buffer.readUInt32LE(descriptorOffset + 4) !== compressedSize ||
          buffer.readUInt32LE(descriptorOffset + 8) !== uncompressedSize) {
        return invalidWorkbook();
      }
      recordEnd = descriptorOffset + 12;
    }
    if (recordEnd > centralOffset) return invalidWorkbook();

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataStart,
      dataEnd,
      recordEnd,
      isDirectory: name.endsWith("/"),
    });
    cursor += entryLength;
  }

  if (cursor !== centralEnd) return invalidWorkbook();
  const localRanges = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index - 1].recordEnd > localRanges[index].localOffset) return invalidWorkbook();
  }

  const declaredTotal = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes) {
    return oversizedWorkbook();
  }
  return entries;
}

function decodeXml(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return invalidWorkbook();
  }
}

function skipUntil(xml: string, start: number, terminator: string): number {
  const end = xml.indexOf(terminator, start);
  if (end === -1) return invalidWorkbook();
  return end + terminator.length;
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi, (entity) => {
    if (entity === "&amp;") return "&";
    if (entity === "&lt;") return "<";
    if (entity === "&gt;") return ">";
    if (entity === "&quot;") return "\"";
    if (entity === "&apos;") return "'";
    const hex = entity.startsWith("&#x") || entity.startsWith("&#X");
    const number = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    if (!Number.isInteger(number) || number < 0 || number > 0x10ffff) return invalidWorkbook();
    return String.fromCodePoint(number);
  });
}

function* scanXmlTags(xml: string): Generator<XmlTag> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) return;
    if (xml.startsWith("<!--", start)) {
      cursor = skipUntil(xml, start + 4, "-->");
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      cursor = skipUntil(xml, start + 9, "]]>");
      continue;
    }
    if (xml.startsWith("<?", start)) {
      cursor = skipUntil(xml, start + 2, "?>");
      continue;
    }
    if (xml.startsWith("<!", start)) return invalidWorkbook();

    let index = start + 1;
    let closing = false;
    if (xml[index] === "/") {
      closing = true;
      index++;
    }
    const nameStart = index;
    while (index < xml.length && !/[\s/>]/.test(xml[index])) index++;
    if (index === nameStart) return invalidWorkbook();
    const name = xml.slice(nameStart, index);
    const attributes: Record<string, string> = {};
    let selfClosing = false;

    while (index < xml.length) {
      while (/\s/.test(xml[index] ?? "")) index++;
      if (xml[index] === ">") {
        index++;
        break;
      }
      if (xml[index] === "/" && xml[index + 1] === ">") {
        selfClosing = true;
        index += 2;
        break;
      }
      if (closing || !xml[index]) return invalidWorkbook();

      const attributeStart = index;
      while (index < xml.length && !/[\s=/>]/.test(xml[index])) index++;
      if (index === attributeStart) return invalidWorkbook();
      const attributeName = xml.slice(attributeStart, index);
      while (/\s/.test(xml[index] ?? "")) index++;
      if (xml[index] !== "=") return invalidWorkbook();
      index++;
      while (/\s/.test(xml[index] ?? "")) index++;
      const quote = xml[index];
      if (quote !== "\"" && quote !== "'") return invalidWorkbook();
      const valueStart = ++index;
      const valueEnd = xml.indexOf(quote, valueStart);
      if (valueEnd === -1) return invalidWorkbook();
      if (attributeName in attributes) return invalidWorkbook();
      attributes[attributeName] = decodeXmlAttribute(xml.slice(valueStart, valueEnd));
      index = valueEnd + 1;
    }
    if (index > xml.length) return invalidWorkbook();
    cursor = index;
    yield { name, closing, selfClosing, attributes };
  }
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

function getFirstSheetPath(workbookXml: Buffer, relationshipsXml: Buffer, limits: XlsxPreflightLimits): string {
  let firstRelationshipId: string | undefined;
  let worksheetCount = 0;
  for (const tag of scanXmlTags(decodeXml(workbookXml))) {
    if (!tag.closing && localName(tag.name) === "sheet") {
      worksheetCount++;
      if (worksheetCount === 1) {
        const relation = Object.entries(tag.attributes).find(([name]) => name.endsWith(":id"));
        firstRelationshipId = relation?.[1];
      }
    }
  }
  if (worksheetCount === 0 || !firstRelationshipId) return invalidWorkbook();
  if (worksheetCount > limits.maxWorksheets) return oversizedWorkbook();

  let target: string | undefined;
  for (const tag of scanXmlTags(decodeXml(relationshipsXml))) {
    if (!tag.closing && localName(tag.name) === "Relationship" &&
        tag.attributes.Id === firstRelationshipId) {
      if (tag.attributes.TargetMode === "External") return invalidWorkbook();
      target = tag.attributes.Target;
      break;
    }
  }
  if (!target) return invalidWorkbook();

  const targetPath = target.startsWith("/")
    ? target.slice(1)
    : `xl/${target}`;
  const normalizedTarget = targetPath.split("/").reduce<string[]>((parts, part) => {
    if (part === "" || part === ".") return parts;
    if (part === "..") {
      if (parts.length === 0) return invalidWorkbook();
      parts.pop();
      return parts;
    }
    parts.push(part);
    return parts;
  }, []).join("/");
  if (!normalizedTarget.startsWith("xl/worksheets/") || !normalizedTarget.endsWith(".xml")) {
    return invalidWorkbook();
  }
  return normalizedTarget;
}

function analyzeWorksheet(xmlBuffer: Buffer, state: PreflightState): void {
  let rowNumber = 0;
  let currentRow: { number: number; hasValue: boolean } | undefined;
  let currentCell = false;
  let dataRows = 0;

  for (const tag of scanXmlTags(decodeXml(xmlBuffer))) {
    const element = localName(tag.name);
    if (element === "row") {
      if (!tag.closing) {
        if (currentRow) return invalidWorkbook();
        const explicitRow = tag.attributes.r;
        rowNumber = explicitRow === undefined ? rowNumber + 1 : Number(explicitRow);
        if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0) return invalidWorkbook();
        if (rowNumber > state.limits.maxRowIndex) return oversizedWorkbook();
        currentRow = { number: rowNumber, hasValue: false };
        if (tag.selfClosing) {
          currentRow = undefined;
        }
      } else {
        if (!currentRow) return invalidWorkbook();
        if (currentRow.number > 1 && currentRow.hasValue) {
          dataRows++;
          if (dataRows > state.limits.maxDataRows) return oversizedWorkbook();
        }
        currentRow = undefined;
      }
      continue;
    }

    if (element === "c") {
      if (!tag.closing) {
        if (!currentRow || currentCell) return invalidWorkbook();
        const reference = tag.attributes.r;
        if (reference) {
          const cellMatch = /^([A-Z]+)([1-9]\d*)$/.exec(reference);
          if (!cellMatch) return invalidWorkbook();
          const cellRow = Number(cellMatch[2]);
          if (!Number.isSafeInteger(cellRow) || cellRow > state.limits.maxRowIndex) {
            return oversizedWorkbook();
          }
        }
        state.cells++;
        if (state.cells > state.limits.maxCells) return oversizedWorkbook();
        currentCell = !tag.selfClosing;
      } else {
        if (!currentCell) return invalidWorkbook();
        currentCell = false;
      }
      continue;
    }

    if (!tag.closing && currentCell && (element === "v" || element === "is" || element === "f")) {
      if (currentRow) currentRow.hasValue = true;
    }
  }

  if (currentRow || currentCell) return invalidWorkbook();
}

async function readEntry(
  buffer: Buffer,
  entry: ZipEntry,
  state: PreflightState,
  collect: boolean,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let actualSize = 0;
  const isXml = /(?:\.xml|\.rels)$/i.test(entry.name);

  const consume = (chunk: Buffer): void => {
    actualSize += chunk.length;
    state.totalBytes += chunk.length;
    if (actualSize > state.limits.maxEntryBytes || state.totalBytes > state.limits.maxTotalBytes) {
      return oversizedWorkbook();
    }
    if (isXml) {
      state.xmlBytes += chunk.length;
      if (state.xmlBytes > state.limits.maxXmlBytes) return oversizedWorkbook();
    }
    if (collect && chunk.length > 0) chunks.push(chunk);
  };

  const compressed = buffer.subarray(entry.dataStart, entry.dataEnd);
  if (entry.method === 0) {
    for (let offset = 0; offset < compressed.length; offset += CHUNK_SIZE) {
      consume(compressed.subarray(offset, offset + CHUNK_SIZE));
    }
  } else {
    try {
      const inflater = createInflateRaw();
      const input = Readable.from([compressed]);
      input.pipe(inflater);
      for await (const chunk of inflater) consume(Buffer.from(chunk));
    } catch (error) {
      if (error instanceof XlsxPreflightError) throw error;
      return invalidWorkbook();
    }
  }

  if (actualSize !== entry.uncompressedSize) return invalidWorkbook();
  return collect ? Buffer.concat(chunks, actualSize) : undefined;
}

export async function preflightXlsx(
  buffer: Buffer,
  limits: XlsxPreflightLimits = XLSX_PREFLIGHT_LIMITS,
): Promise<void> {
  const entries = getZipEntries(buffer, limits);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const contentTypes = byName.get("[Content_Types].xml");
  const workbookEntry = byName.get("xl/workbook.xml");
  const relationshipsEntry = byName.get("xl/_rels/workbook.xml.rels");
  if (!contentTypes || !workbookEntry || !relationshipsEntry) return invalidWorkbook();

  const state: PreflightState = { totalBytes: 0, xmlBytes: 0, cells: 0, limits };
  const completed = new Set<string>();
  const workbookXml = await readEntry(buffer, workbookEntry, state, true);
  const relationshipsXml = await readEntry(buffer, relationshipsEntry, state, true);
  completed.add(workbookEntry.name);
  completed.add(relationshipsEntry.name);
  const firstSheetPath = getFirstSheetPath(workbookXml!, relationshipsXml!, limits);
  const firstSheetEntry = byName.get(firstSheetPath);
  if (!firstSheetEntry || firstSheetEntry.isDirectory) return invalidWorkbook();

  let worksheetCount = 0;
  let firstSheetProcessed = false;
  for (const entry of entries) {
    if (completed.has(entry.name)) continue;
    const isWorksheet = /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name);
    if (isWorksheet) {
      worksheetCount++;
      if (worksheetCount > limits.maxWorksheets) return oversizedWorkbook();
    }

    const collect = isWorksheet;
    const content = await readEntry(buffer, entry, state, collect);
    if (entry.name === firstSheetPath) {
      if (!content) return invalidWorkbook();
      analyzeWorksheet(content, state);
      firstSheetProcessed = true;
    } else if (isWorksheet && content) {
      analyzeWorksheet(content, state);
    }
  }

  if (!firstSheetProcessed) return invalidWorkbook();
}
