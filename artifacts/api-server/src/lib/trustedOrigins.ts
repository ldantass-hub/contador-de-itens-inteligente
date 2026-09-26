const DEVELOPMENT_ORIGIN = "http://localhost:5173";

function getTrustedOrigins(): readonly string[] {
  if (process.env.NODE_ENV !== "production") {
    return [DEVELOPMENT_ORIGIN];
  }

  const configuredOrigin = process.env.CORS_ORIGIN;
  if (!configuredOrigin) {
    throw new Error("CORS_ORIGIN must be configured in production.");
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(configuredOrigin);
  } catch {
    throw new Error("CORS_ORIGIN must be a single exact HTTPS origin.");
  }

  if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== configuredOrigin) {
    throw new Error("CORS_ORIGIN must be a single exact HTTPS origin.");
  }

  return [parsedOrigin.origin];
}

const trustedOrigins = getTrustedOrigins();

export function isTrustedOrigin(origin: string): boolean {
  return trustedOrigins.includes(origin);
}