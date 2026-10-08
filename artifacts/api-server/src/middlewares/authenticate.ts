import type { Request, Response, NextFunction } from "express";
import { verifyToken, type JwtPayload } from "../lib/jwtUtils.js";
import { ACCESS_TOKEN_COOKIE } from "../lib/authCookie.js";
import { getAuthUserById } from "../lib/db.js";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & { mustChangePassword?: boolean };
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[ACCESS_TOKEN_COOKIE];

  if (!token) {
    res.status(401).json({ error: "Não autenticado." });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Token inválido ou expirado." });
    return;
  }

  const user = await getAuthUserById(payload.userId);
  if (!user || user.authVersion !== payload.authVersion) {
    res.status(401).json({ error: "Token inválido ou expirado." });
    return;
  }

  const originalUrl = req.originalUrl ?? req.url ?? "";
  const isPasswordResetRoute =
    originalUrl === "/api/auth/password" ||
    req.path === "/password" ||
    originalUrl.endsWith("/api/auth/password");

  if (user.mustChangePassword && !isPasswordResetRoute) {
    res.status(403).json({ error: "Você deve alterar sua senha antes de continuar." });
    return;
  }

  req.user = {
    userId: user.id,
    username: user.username,
    role: user.role,
    authVersion: user.authVersion,
    mustChangePassword: user.mustChangePassword,
  };
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Acesso restrito a administradores." });
    return;
  }
  next();
}
