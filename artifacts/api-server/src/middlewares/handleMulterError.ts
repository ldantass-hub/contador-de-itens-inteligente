import type { NextFunction, Request, Response } from "express";
import multer from "multer";

export function handleMulterError(
  error: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(error instanceof multer.MulterError)) {
    next(error);
    return;
  }

  const tooLarge = error.code === "LIMIT_FILE_SIZE";
  res.status(tooLarge ? 413 : 400).json({
    error: tooLarge
      ? "Arquivo excede o limite permitido."
      : "Requisição de upload inválida.",
  });
}