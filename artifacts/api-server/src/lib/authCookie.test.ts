import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCookieOptions(nodeEnv: string) {
  vi.stubEnv("NODE_ENV", nodeEnv);
  vi.resetModules();
  return import("./authCookie.js");
}

describe("authentication cookie", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an HttpOnly, root-scoped, lax cookie in development", async () => {
    const { ACCESS_TOKEN_COOKIE, accessTokenCookieOptions } = await loadCookieOptions("development");

    expect(ACCESS_TOKEN_COOKIE).toBe("access_token");
    expect(accessTokenCookieOptions).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: false,
    });
  });

  it("marks the cookie secure in production", async () => {
    const { accessTokenCookieOptions } = await loadCookieOptions("production");

    expect(accessTokenCookieOptions).toMatchObject({ httpOnly: true, secure: true });
  });
});