import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";

const SECRET = "unit-test-secret-with-at-least-32-characters";
const PAYLOAD = { userId: 23, username: "operator", role: "user", authVersion: 1 };

async function loadJwtUtils(secret: string) {
  vi.stubEnv("JWT_SECRET", secret);
  vi.resetModules();
  return import("./jwtUtils.js");
}

describe("JWT utilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails module initialization when JWT_SECRET is missing", async () => {
    await expect(loadJwtUtils("")).rejects.toThrow("missing JWT_SECRET");
  });

  it("fails module initialization when JWT_SECRET is too short", async () => {
    await expect(loadJwtUtils("short-secret")).rejects.toThrow("at least 32 characters");
  });

  it("signs payloads with an eight-hour expiration and verifies them", async () => {
    const { signToken, verifyToken } = await loadJwtUtils(SECRET);
    const token = signToken(PAYLOAD);
    const decoded = jwt.decode(token);

    expect(verifyToken(token)).toMatchObject(PAYLOAD);
    expect(decoded).toMatchObject(PAYLOAD);
    expect(decoded && typeof decoded !== "string" ? decoded.exp! - decoded.iat! : null).toBe(
      8 * 60 * 60,
    );
  });

  it("returns null for malformed and expired tokens", async () => {
    const { verifyToken } = await loadJwtUtils(SECRET);
    const expiredToken = jwt.sign(PAYLOAD, SECRET, { expiresIn: -1 });

    expect(verifyToken("not-a-jwt")).toBeNull();
    expect(verifyToken(expiredToken)).toBeNull();
  });

  it("returns null when a token was signed with another secret", async () => {
    const first = await loadJwtUtils(SECRET);
    const token = first.signToken(PAYLOAD);
    const second = await loadJwtUtils(`${SECRET}-different`);

    expect(second.verifyToken(token)).toBeNull();
  });
});