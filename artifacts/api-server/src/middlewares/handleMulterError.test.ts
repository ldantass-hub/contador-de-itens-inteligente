import multer from "multer";
import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { handleMulterError } from "./handleMulterError.js";

function createResponse() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

function createNext() {
  return vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
}

const MULTIPART_LIMIT_CODES = [
  "LIMIT_FILE_COUNT",
  "LIMIT_PART_COUNT",
  "LIMIT_FIELD_COUNT",
  "LIMIT_UNEXPECTED_FILE",
] as const satisfies readonly ConstructorParameters<typeof multer.MulterError>[0][];

describe("handleMulterError", () => {
  it("maps LIMIT_FILE_SIZE to a generic 413 response", () => {
    const response = createResponse();
    const next = createNext();

    handleMulterError(new multer.MulterError("LIMIT_FILE_SIZE"), {} as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.json).toHaveBeenCalledWith({ error: "Arquivo excede o limite permitido." });
    expect(next).not.toHaveBeenCalled();
  });

  it.each(MULTIPART_LIMIT_CODES)("maps %s to a generic 400 response", (code) => {
    const response = createResponse();
    const next = createNext();

    handleMulterError(new multer.MulterError(code), {} as Request, response, next);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: "Requisição de upload inválida." });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes non-Multer errors to the next error handler", () => {
    const response = createResponse();
    const next = createNext();
    const error = new Error("unexpected");

    handleMulterError(error, {} as Request, response, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(response.status).not.toHaveBeenCalled();
  });
});
