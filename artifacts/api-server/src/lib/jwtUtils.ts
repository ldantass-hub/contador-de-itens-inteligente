import jwt from "jsonwebtoken";

/*
 * JWT configuration
 *
 * SECRET: falls back to the original development key so existing tokens remain
 * valid across server restarts when JWT_SECRET is not set in the environment.
 * In production, always set JWT_SECRET to a cryptographically random string
 * (e.g. `openssl rand -hex 64`).  The env-var value takes priority over the
 * hard-coded fallback.
 *
 * EXPIRES: 8 hours — one work shift.  Previously 7 days; reduced to limit
 * the exposure window of stolen tokens.
 */
const SECRET  = process.env.JWT_SECRET ?? "lgelectronics-inventory-2026-secret";
const EXPIRES = "8h";

export interface JwtPayload {
  userId:   number;
  username: string;
  role:     string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, SECRET) as JwtPayload;
  } catch {
    return null;
  }
}
