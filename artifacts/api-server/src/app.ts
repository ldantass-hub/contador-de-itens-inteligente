import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

/* ── Trust Replit's reverse proxy ───────────────────────────────────────────
   Required so that req.ip reflects the real client IP (used by rate limiters)
   rather than the proxy's internal address.
*/
app.set("trust proxy", 1);

/* ── Security headers (helmet-equivalent, no extra dependency) ──────────────
   Applied before every response.  These stop the most common passive attacks:
   - X-Content-Type-Options: nosniff   → blocks MIME-type sniffing
   - X-Frame-Options: DENY             → blocks clickjacking
   - X-XSS-Protection: 0               → disables the old broken XSS auditor
   - Referrer-Policy                   → limits referrer leakage
   - Permissions-Policy                → opt out of browser features we don't use
*/
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

/* ── CORS ───────────────────────────────────────────────────────────────────
   Restrict cross-origin access to known origins.
   CORS_ORIGIN env var overrides — set it in production to the exact domain.
   In development the Replit proxy rewrites origins, so we also allow the
   *.replit.dev and *.replit.app wildcard patterns.
*/
const allowedOriginPattern = /^https?:\/\/(localhost:5173|.*\.replit\.dev|.*\.replit\.app|.*\.riker\.replit\.dev)$/;

app.use(
  cors({
    origin: (origin, callback) => {
      /* Allow same-origin requests (no Origin header) and known patterns */
      if (!origin || allowedOriginPattern.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
    methods:      ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials:  true,
    maxAge:       86400, /* cache preflight for 24 h */
  }),
);

app.use(cookieParser());

/* ── Request body limits ────────────────────────────────────────────────────
   Prevents memory exhaustion from oversized JSON payloads.
   File uploads (multer) set their own limit inside the route.
*/
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

/* ── General API rate limiter ───────────────────────────────────────────────
   Coarse guard on the entire /api surface — 200 requests per 15 minutes per
   IP.  The login route has its own, much tighter limiter (5 / 15 min).
   Adjust max in production to match expected legitimate traffic.
*/
const generalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             200,
  standardHeaders: "draft-7",
  legacyHeaders:   false,
  message: { error: "Muitas requisições. Tente novamente em alguns minutos." },
  /* Default keyGenerator used — handles IPv4/IPv6 correctly with trust proxy */
});

/* ── Request logger ─────────────────────────────────────────────────────────
   Logs method + path (no query string — avoids logging tokens in URLs).
*/
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

/* ── Routes ─────────────────────────────────────────────────────────────────*/
app.use("/api", generalLimiter, router);

/* ── 404 handler ────────────────────────────────────────────────────────────
   Catches any request that fell through all registered routes.
*/
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Recurso não encontrado." });
});

/* ── Global error handler ───────────────────────────────────────────────────
   Express calls this when next(err) is invoked or a sync route throws.
   We log the full error internally but return a generic message to the client
   so internal details (stack traces, file paths) are never exposed.
*/
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ err }, "Unhandled error");
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: "Erro interno do servidor." });
});

export default app;
