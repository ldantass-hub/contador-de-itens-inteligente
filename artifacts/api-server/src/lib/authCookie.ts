export const ACCESS_TOKEN_COOKIE = "access_token";

export const accessTokenCookieOptions = {
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};