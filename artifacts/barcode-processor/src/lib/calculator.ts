import { processInput } from "./barcodeProcessor";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface CalculatorTarget {
  id: string;
  code: string | null;
  isError: boolean;
}

export interface CalculatorEntry extends CalculatorTarget {
  raw: string;
  quantity: number | null;
  timestamp: Date;
  log: string;
}

export function isValidCalculatedQuantity(value: number | null, currentTotal: number): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0 &&
    value <= POSTGRES_INTEGER_MAX && currentTotal + value <= POSTGRES_INTEGER_MAX;
}

export function evaluateExpression(expression: string): number | null {
  const normalized = expression.replace(/\s/g, "");
  const matchedTokens = normalized.match(/\d+(?:\.\d+)?|[+\-*/]/g);
  if (!matchedTokens || matchedTokens.join("") !== normalized) return null;
  const tokens = matchedTokens;

  let position = 0;

  function parseFactor(): number | null {
    const token = tokens[position];
    if (token === "+" || token === "-") {
      position++;
      const value = parseFactor();
      return value === null ? null : token === "-" ? -value : value;
    }
    if (!token || !/^\d/.test(token)) return null;
    position++;
    return Number(token);
  }

  function parseTerm(): number | null {
    let value = parseFactor();
    if (value === null) return null;

    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++];
      const right = parseFactor();
      if (right === null || (operator === "/" && right === 0)) return null;
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }

  function parseExpression(): number | null {
    let value = parseTerm();
    if (value === null) return null;

    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      const right = parseTerm();
      if (right === null) return null;
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  const result = parseExpression();
  return result !== null && position === tokens.length && Number.isFinite(result)
    ? result
    : null;
}

export function findCalculatorTarget<T extends CalculatorTarget>(
  items: T[],
  activeCode: string | null,
): T | null {
  if (!activeCode) return null;
  const matchesActiveCode = (item: T) => !item.isError && item.code === activeCode;
  return items.find(matchesActiveCode) ?? null;
}

export function appendCalculatedQuantity<T extends CalculatorEntry>(
  items: T[],
  rawLines: string[],
  quantity: number,
  entry: Omit<T, "code" | "isError" | "quantity" | "log" | "raw">,
): { items: T[]; rawLines: string[] } | null {
  if (!isValidCalculatedQuantity(quantity, 0)) return null;
  if (items.length !== rawLines.length) return null;

  const before = rawLines.length ? processInput(rawLines.join("\n")) : null;
  if (!before?.activeCode || !isValidCalculatedQuantity(quantity, before.total)) return null;

  const target = findCalculatorTarget(items, before.activeCode);
  if (!target) return null;

  const nextRawLines = [...rawLines, String(quantity)];
  const after = processInput(nextRawLines.join("\n"));
  if (after.activeCode !== target.code || after.total !== before.total + quantity) return null;

  const newItem = {
    ...entry,
    raw: String(quantity),
    code: target.code,
    quantity,
    isError: false,
    log: after.logs[after.logs.length - 1] ?? "",
  } as T;

  return { items: [newItem, ...items], rawLines: nextRawLines };
}

export function confirmCalculatorResult<T extends CalculatorEntry>(
  items: T[],
  rawLines: string[],
  expression: string,
  entry: Omit<T, "code" | "isError" | "quantity" | "log" | "raw">,
): { items: T[]; rawLines: string[]; appliedQuantity: number; expression: "" } | null {
  if (!expression.trim()) return null;
  const quantity = evaluateExpression(expression);
  const currentTotal = rawLines.length ? processInput(rawLines.join("\n")).total : 0;
  if (!isValidCalculatedQuantity(quantity, currentTotal)) return null;

  const updated = appendCalculatedQuantity(items, rawLines, quantity, entry);
  return updated ? { ...updated, appliedQuantity: quantity, expression: "" } : null;
}