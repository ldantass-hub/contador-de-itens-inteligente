import { afterEach, describe, expect, it, vi } from "vitest";

async function loadTrustedOrigins(nodeEnv: string, origin = "") {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.stubEnv("CORS_ORIGIN", origin);
  vi.resetModules();
  return import("./trustedOrigins.js");
}

describe("trusted origins", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows only the development origin outside production", async () => {
    const { isTrustedOrigin } = await loadTrustedOrigins("test");

    expect(isTrustedOrigin("http://localhost:5173")).toBe(true);
    expect(isTrustedOrigin("http://127.0.0.1:5173")).toBe(false);
    expect(isTrustedOrigin("https://localhost:5173")).toBe(false);
  });

  it("allows the configured exact HTTPS origin in production", async () => {
    const { isTrustedOrigin } = await loadTrustedOrigins("production", "https://inventory.example");

    expect(isTrustedOrigin("https://inventory.example")).toBe(true);
    expect(isTrustedOrigin("https://sub.inventory.example")).toBe(false);
    expect(isTrustedOrigin("http://inventory.example")).toBe(false);
  });

  it("requires CORS_ORIGIN in production", async () => {
    await expect(loadTrustedOrigins("production")).rejects.toThrow(
      "CORS_ORIGIN must be configured in production.",
    );
  });

  it.each([
    "http://inventory.example",
    "https://inventory.example/",
    "https://inventory.example/path",
    "https://inventory.example,https://other.example",
    "not-an-origin",
  ])("rejects non-exact production origin configuration %j", async (origin) => {
    await expect(loadTrustedOrigins("production", origin)).rejects.toThrow(
      "CORS_ORIGIN must be a single exact HTTPS origin.",
    );
  });
});