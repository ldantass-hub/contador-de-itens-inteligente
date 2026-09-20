import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { findUserByUsername, getActiveSession, finalizeSession } from "../lib/db.js";
import { signToken } from "../lib/jwtUtils.js";
import { authenticate } from "../middlewares/authenticate.js";

const router = Router();

/*
 * C2 FIX — Brute-force protection on the login endpoint
 *
 * Strategy: IP-based sliding-window limiter.
 *   - 5 failed-or-successful attempts per 15 minutes per IP.
 *   - After 5 attempts the endpoint returns 429 with a Retry-After header.
 *   - skipSuccessfulRequests: false — counts every call so an attacker
 *     cannot enumerate usernames by observing which calls are "free".
 *   - standardHeaders / legacyHeaders: sends RFC-compliant RateLimit headers
 *     so clients can back off gracefully.
 *
 * Note: in a horizontally scaled deployment, replace the default in-memory
 * store with a shared store (e.g. rate-limit-redis) so limits are shared
 * across all instances.
 */
const loginLimiter = rateLimit({
  windowMs:              15 * 60 * 1000, /* 15-minute window */
  max:                   5,              /* max 5 attempts per window per IP */
  standardHeaders:       "draft-7",      /* RateLimit headers (RFC 9110) */
  legacyHeaders:         false,
  skipSuccessfulRequests: false,         /* count every attempt, not just failures */
  message: { error: "Muitas tentativas de login. Tente novamente em 15 minutos." },
  /* Default keyGenerator used — handles IPv4/IPv6 correctly with trust proxy */
});

/* ── POST /api/auth/login ───────────────────────────────────────────────────
   Body: { username, password }
   Returns the token and, when applicable, the active session that must be resumed.
   A new session is created only after the organization is selected.
*/
router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || typeof username !== "string" || !password || typeof password !== "string") {
    res.status(400).json({ error: "Usuário e senha são obrigatórios." });
    return;
  }

  /* Normalise — trim whitespace, enforce max length to prevent DoS */
  const cleanUser = username.trim().slice(0, 100);
  const cleanPass = password.slice(0, 200);

  if (!cleanUser || !cleanPass) {
    res.status(400).json({ error: "Usuário e senha são obrigatórios." });
    return;
  }

  const user = findUserByUsername(cleanUser);
  if (!user) {
    /*
     * Use a constant-time comparison even on the "not found" path to prevent
     * timing-based user enumeration.  bcrypt.compare on a dummy hash takes
     * ~100 ms just like a real compare.
     */
    await bcrypt.compare(cleanPass, "$2b$10$invalidhashpadding000000000000000000000000000000000000");
    res.status(401).json({ error: "Usuário ou senha inválidos." });
    return;
  }

  const match = await bcrypt.compare(cleanPass, user.password);
  if (!match) {
    res.status(401).json({ error: "Usuário ou senha inválidos." });
    return;
  }

  const token    = signToken({ userId: user.id, username: user.username, role: user.role });
  const safeUser = { id: user.id, username: user.username, role: user.role };

  /* Check for existing active session */
  const existing = getActiveSession(user.id);
  if (existing) {
    const lastUpdate  = new Date(existing.last_update + "Z");
    const ageMs       = Date.now() - lastUpdate.getTime();
    const twoHoursMs  = 2 * 60 * 60 * 1000;

    if (ageMs < twoHoursMs) {
      res.json({ token, user: safeUser, activeSession: existing, needsResume: true });
      return;
    }

    finalizeSession(existing.id);
  }

  res.json({ token, user: safeUser, needsResume: false });
});

/* ── GET /api/auth/me ───────────────────────────────────────────────────────
   Returns the currently authenticated user.
*/
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
