import jwt from "jsonwebtoken";

function getJwtSecret(): string {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret || jwtSecret.trim().length === 0) {
    throw new Error("JWT configuration error: missing JWT_SECRET.");
  }

  if (jwtSecret.trim().length < 32) {
    throw new Error("JWT configuration error: JWT_SECRET must be at least 32 characters.");
  }

  return jwtSecret;
}

/*
 * JWT configuration
 *
 * Require an explicit environment secret. A missing or weak JWT_SECRET fails the
 * backend at startup rather than silently accepting predictable tokens.
 *
 * EXPIRES: 8 hours — one work shift.  Previously 7 days; reduced to limit
 * the exposure window of stolen tokens.
 */
const SECRET  = getJwtSecret();
const EXPIRES = "8h";

export interface JwtPayload {
  userId:   number;
  username: string;
  role:     string;
  authVersion: number;
  mustChangePassword?: boolean;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, SECRET);
    if (
      typeof payload !== "object" ||
      payload === null ||
      !Number.isSafeInteger(payload.userId) ||
      payload.userId <= 0 ||
      typeof payload.username !== "string" ||
      typeof payload.role !== "string" ||
      !Number.isSafeInteger(payload.authVersion) ||
      payload.authVersion < 1
    ) {
      return null;
    }
    return payload as JwtPayload;
  } catch {
    return null;
  }
}
