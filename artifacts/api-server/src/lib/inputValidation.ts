const POSTGRES_INTEGER_MAX = 2_147_483_647;

export function parsePostgresId(value: unknown): number | null {
  const parsed = typeof value === "string" && /^[0-9]+$/.test(value)
    ? Number(value)
    : value;

  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > POSTGRES_INTEGER_MAX) {
    return null;
  }

  return parsed;
}

export function parsePostgresQuantity(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > POSTGRES_INTEGER_MAX) {
    return null;
  }

  return value;
}