import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { findUserByUsername, findUserById, getActiveSession, finalizeSession, updateUserPassword } from "../lib/db.js";
import { signToken } from "../lib/jwtUtils.js";
import { ACCESS_TOKEN_COOKIE, accessTokenCookieOptions } from "../lib/authCookie.js";
import { authenticate } from "../middlewares/authenticate.js";

const router = Router();

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_MAX = 20;
const LOGIN_USERNAME_MAX = 5;

function normalizeUsernameForRateLimit(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().slice(0, 100);
}

/*
 * Brute-force protection on the login endpoint.
 *
 * Strategy: layered limiters to preserve IP flood protection while reducing the
 * risk of targeted brute-force against a single account behind a shared NAT.
 *
 * - IP limiter protects against abusive traffic and flood from a shared public IP.
 * - Username limiter protects against brute force against a single account.
 * - Successful logins do not consume the failure buckets.
 * - standardHeaders / legacyHeaders: sends RFC-compliant RateLimit headers.
 */
const loginIpLimiter = rateLimit({
  windowMs:              LOGIN_WINDOW_MS,
  max:                   LOGIN_IP_MAX,
  standardHeaders:       "draft-7",
  legacyHeaders:         false,
  skipSuccessfulRequests: true,
  message: { error: "Muitas tentativas de login. Tente novamente em 15 minutos." },
  /* Default keyGenerator used — handles IPv4/IPv6 correctly with trust proxy */
});

const loginUsernameLimiter = rateLimit({
  windowMs:              LOGIN_WINDOW_MS,
  max:                   LOGIN_USERNAME_MAX,
  standardHeaders:       "draft-7",
  legacyHeaders:         false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const normalizedUsername = normalizeUsernameForRateLimit(
      (req.body as { username?: unknown } | undefined)?.username,
    );
    return `username:${normalizedUsername || "unknown"}`;
  },
  message: { error: "Muitas tentativas de login. Tente novamente em 15 minutos." },
});

/* ── POST /api/auth/login ───────────────────────────────────────────────────
  Body: { username, password }
  Sets the authentication cookie and, when applicable, returns the active
  session that must be resumed.
   A new session is created only after the organization is selected.
*/
router.post("/login", loginIpLimiter, loginUsernameLimiter, async (req, res) => {
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

  const user = await findUserByUsername(cleanUser);
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
  res.cookie(ACCESS_TOKEN_COOKIE, token, accessTokenCookieOptions);

  /* Check for existing active session */
  const existing = await getActiveSession(user.id);
  if (existing) {
    const lastUpdate  = new Date(existing.last_update);
    const ageMs       = Date.now() - lastUpdate.getTime();
    const twoHoursMs  = 2 * 60 * 60 * 1000;

    if (ageMs < twoHoursMs) {
      res.json({ user: safeUser, activeSession: existing, needsResume: true });
      return;
    }

    await finalizeSession(existing.id, user.id);
  }

  res.json({ user: safeUser, needsResume: false });
});

/* ── GET /api/auth/me ───────────────────────────────────────────────────────
   Returns the currently authenticated user.
*/
router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

/* ── POST /api/auth/logout ────────────────────────────────────────────────── */
router.post("/logout", (_req, res) => {
  res.clearCookie(ACCESS_TOKEN_COOKIE, accessTokenCookieOptions);
  res.json({ message: "Logout realizado com sucesso." });
});

/* ── PUT /api/auth/password ──────────────────────────────────────────────── */
router.put("/password", authenticate, async (req, res) => {
  const body = (req.body ?? {}) as {
    currentPassword?: unknown;
    newPassword?: unknown;
    confirmPassword?: unknown;
  };

  if (
    typeof body.currentPassword !== "string" ||
    typeof body.newPassword !== "string" ||
    typeof body.confirmPassword !== "string" ||
    !body.currentPassword ||
    !body.newPassword ||
    !body.confirmPassword
  ) {
    res.status(400).json({ error: "Preencha todos os campos de senha." });
    return;
  }

  if (body.currentPassword.length > 200 || body.newPassword.length > 200 || body.confirmPassword.length > 200) {
    res.status(400).json({ error: "A senha excede o limite permitido." });
    return;
  }

  if (body.newPassword.length < 12) {
    res.status(400).json({ error: "A nova senha deve ter no mínimo 12 caracteres." });
    return;
  }

  if (body.newPassword !== body.confirmPassword) {
    res.status(400).json({ error: "A confirmação da nova senha não confere." });
    return;
  }

  const user = await findUserById(req.user!.userId);
  if (!user || !(await bcrypt.compare(body.currentPassword, user.password))) {
    res.status(400).json({ error: "Não foi possível alterar a senha informada." });
    return;
  }

  const passwordHash = await bcrypt.hash(body.newPassword, 10);
  const updated = await updateUserPassword(req.user!.userId, passwordHash);
  if (!updated) {
    res.status(400).json({ error: "Não foi possível alterar a senha informada." });
    return;
  }

  res.json({ message: "Senha alterada com sucesso." });
});

export default router;
