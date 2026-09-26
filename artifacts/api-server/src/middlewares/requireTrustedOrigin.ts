import type { Request, Response, NextFunction } from "express";
import { isTrustedOrigin } from "../lib/trustedOrigins.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requireTrustedOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const origin = req.get("Origin");
  if (!origin || !isTrustedOrigin(origin)) {
    res.status(403).json({ error: "Origem da requisição não permitida." });
    return;
  }

  next();
}