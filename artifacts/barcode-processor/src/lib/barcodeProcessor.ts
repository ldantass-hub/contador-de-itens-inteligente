export type InputFormat =
  | "invalid"
  | "exception"
  | "standard"
  | "dot_separated"
  | "quantity_only"
  | "code_only"
  | "code_with_noise";

export interface ParsedRecord {
  code: string;
  quantity: number;
}

export interface ProcessResult {
  activeCode: string | null;
  total: number;
  logs: string[];
}

/* ── Constants ───────────────────────────────────────────────────────────── */

const CODE_LENGTH = 11;

/* ── Exception codes (bypass all parsing, treated as valid codes only) ───── */

const EXCEPTION_CODES = new Set([
  "624-087J",
  "624-085D",
  "624-087H",
  "624-087B",
  "624-087D",
  "586-008B",
  "6631R-G007H",
]);

function isExceptionCode(text: string): boolean {
  return EXCEPTION_CODES.has(text);
}

/* ── Input sanitizer ─────────────────────────────────────────────────────── */

/**
 * Strip all leading non-alphanumeric characters from a scanned string.
 * Applied before any parsing so scanner prefixes (e.g. P, ], ««) are
 * transparently removed. Middle and trailing characters are never touched.
 */
function sanitizeInput(raw: string): string {
  let i = 0;
  while (i < raw.length && !/^[a-zA-Z0-9]$/.test(raw[i])) {
    i++;
  }
  return raw.slice(i);
}

/* ── Primitive validators ────────────────────────────────────────────────── */

function isAlphanumeric(text: string): boolean {
  if (text.length === 0) return false;
  return /^[a-zA-Z0-9]+$/.test(text);
}

/**
 * A valid product code is EXACTLY 11 alphanumeric characters.
 * Exception codes (shorter, may contain hyphens) are handled separately.
 */
function isValidCode(code: string): boolean {
  return code.length === CODE_LENGTH && isAlphanumeric(code);
}

function parsePositiveInteger(text: string): number | null {
  if (text.length === 0) return null;
  if (!/^[0-9]+$/.test(text)) return null;
  const val = parseInt(text, 10);
  if (isNaN(val) || val <= 0) return null;
  return val;
}

/* ── Format extractors ───────────────────────────────────────────────────── */

/**
 * Format: CODE;QUANTITY or CODE;QUANTITY;NOISE (extra parts after 2nd ';' are ignored).
 */
function extractStandardFormat(line: string): ParsedRecord | null {
  const parts    = line.split(";");
  if (parts.length < 2) return null;

  const codePart = parts[0].trim();
  const qtyPart  = parts[1].trim();

  if (!isValidCode(codePart)) return null;

  const qty = parsePositiveInteger(qtyPart);
  if (qty === null) return null;

  return { code: codePart, quantity: qty };
}

/**
 * Format: CODE.NOISE.QUANTITY (dot-separated — code first, qty last).
 */
function extractDotFormat(line: string): ParsedRecord | null {
  const parts = line.split(".");
  if (parts.length < 2) return null;

  const codePart  = parts[0].trim();
  const lastPart  = parts[parts.length - 1].trim();

  if (!isValidCode(codePart)) return null;

  const qty = parsePositiveInteger(lastPart);
  if (qty === null) return null;

  return { code: codePart, quantity: qty };
}

/**
 * Format: CODE only (exactly 11 alphanumeric chars, nothing else).
 */
function extractCodeOnly(line: string): string | null {
  if (!isValidCode(line)) return null;
  return line;
}

/**
 * Format: Concatenated barcode — CODE(11) + NOISE + QUANTITY(trailing digits).
 *
 * Algorithm (no guessing):
 *   1. Input must be all-alphanumeric and longer than CODE_LENGTH.
 *   2. CODE  = input[0 : CODE_LENGTH]          → must be a valid 11-char code.
 *   3. REST  = input[CODE_LENGTH :]
 *   4. Scan REST from the right to collect trailing digits (quantity).
 *   5. Parse quantity as a positive integer (rejects "000").
 */
function extractCodeWithNoise(
  line: string,
  activeCode: string | null
): ParsedRecord | null {
  if (!isAlphanumeric(line) || line.length <= CODE_LENGTH) return null;

  const codePart = line.slice(0, CODE_LENGTH);
  if (!isValidCode(codePart)) return null;

  const rest = line.slice(CODE_LENGTH);

  let startOfQty = rest.length;
  while (startOfQty > 0 && /[0-9]/.test(rest[startOfQty - 1])) {
    startOfQty--;
  }

  if (startOfQty === rest.length) return null;
  const qtyStr = rest.slice(startOfQty);
  const qty    = parsePositiveInteger(qtyStr);
  if (qty === null) return null;

  if (activeCode !== null && codePart !== activeCode) return null;

  return { code: codePart, quantity: qty };
}

/* ── Format detector ─────────────────────────────────────────────────────── */

function detectFormat(line: string, activeCode: string | null): InputFormat {
  if (isExceptionCode(line))                               return "exception";
  if (line.includes(";"))                                  return "standard";
  if (line.includes(".") && !isAlphanumeric(line))         return "dot_separated";
  if (parsePositiveInteger(line) !== null)                 return "quantity_only";
  if (line.length === CODE_LENGTH && isAlphanumeric(line)) return "code_only";
  if (extractCodeWithNoise(line, activeCode) !== null)     return "code_with_noise";
  return "invalid";
}

/* ── Main processing function ────────────────────────────────────────────── */

export function processInput(rawInput: string): ProcessResult {
  const lines = rawInput.split(/\r?\n/);
  const logs: string[] = [];
  let activeCode: string | null = null;
  let total = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw     = lines[i].replace(/\r?\n/, "").trim();
    const line    = sanitizeInput(raw);

    if (line.length === 0) continue;

    const format = detectFormat(line, activeCode);

    switch (format) {
      case "exception": {
        if (activeCode === null) {
          activeCode = line;
          logs.push(`Linha ${lineNum}: [EXCECAO] Codigo definido="${line}"`);
        } else if (line !== activeCode) {
          logs.push(
            `Linha ${lineNum}: Erro: codigo diferente ignorado ("${line}" != "${activeCode}")`
          );
        } else {
          logs.push(`Linha ${lineNum}: [EXCECAO] Codigo confirmado="${line}"`);
        }
        break;
      }

      case "standard": {
        const record = extractStandardFormat(line);
        if (!record) {
          logs.push(`Linha ${lineNum}: Erro: entrada invalida ("${line}")`);
          break;
        }
        if (activeCode === null) activeCode = record.code;
        if (record.code !== activeCode) {
          logs.push(
            `Linha ${lineNum}: Erro: codigo diferente ignorado ("${record.code}" != "${activeCode}")`
          );
          break;
        }
        total += record.quantity;
        logs.push(
          `Linha ${lineNum}: [PADRAO] Codigo="${record.code}" Quantidade=${record.quantity}`
        );
        break;
      }

      case "dot_separated": {
        const record = extractDotFormat(line);
        if (!record) {
          logs.push(`Linha ${lineNum}: Erro: entrada invalida ("${line}")`);
          break;
        }
        if (activeCode === null) activeCode = record.code;
        if (record.code !== activeCode) {
          logs.push(
            `Linha ${lineNum}: Erro: codigo diferente ignorado ("${record.code}" != "${activeCode}")`
          );
          break;
        }
        total += record.quantity;
        logs.push(
          `Linha ${lineNum}: [PONTO] Codigo="${record.code}" Quantidade=${record.quantity}`
        );
        break;
      }

      case "quantity_only": {
        const qty = parsePositiveInteger(line);
        if (qty === null) {
          logs.push(`Linha ${lineNum}: Erro: quantidade invalida ("${line}")`);
          break;
        }
        if (activeCode === null) {
          logs.push(`Linha ${lineNum}: Erro: codigo nao definido`);
          break;
        }
        total += qty;
        logs.push(
          `Linha ${lineNum}: [QUANTIDADE] Codigo="${activeCode}" Quantidade=${qty}`
        );
        break;
      }

      case "code_only": {
        const code = extractCodeOnly(line);
        if (!code) {
          logs.push(`Linha ${lineNum}: Erro: entrada invalida ("${line}")`);
          break;
        }
        if (activeCode === null) {
          activeCode = code;
          logs.push(`Linha ${lineNum}: [CODIGO] Codigo definido="${code}"`);
          break;
        }
        if (code !== activeCode) {
          logs.push(
            `Linha ${lineNum}: Erro: codigo diferente ignorado ("${code}" != "${activeCode}")`
          );
        } else {
          logs.push(`Linha ${lineNum}: [CODIGO] Codigo confirmado="${code}"`);
        }
        break;
      }

      case "code_with_noise": {
        const record = extractCodeWithNoise(line, activeCode);
        if (!record) {
          logs.push(`Linha ${lineNum}: Erro: entrada invalida ("${line}")`);
          break;
        }
        if (activeCode === null) activeCode = record.code;
        if (record.code !== activeCode) {
          logs.push(
            `Linha ${lineNum}: Erro: codigo diferente ignorado ("${record.code}" != "${activeCode}")`
          );
          break;
        }
        total += record.quantity;
        logs.push(
          `Linha ${lineNum}: [CODIGO+RUIDO] Codigo="${record.code}" Quantidade=${record.quantity}`
        );
        break;
      }

      case "invalid":
      default: {
        logs.push(`Linha ${lineNum}: Erro: entrada invalida ("${line}")`);
        break;
      }
    }
  }

  return { activeCode, total, logs };
}
