# LG Electronics Brasil — Inventory Counting System (2026)

## Overview

pnpm workspace monorepo using TypeScript. Production-level barcode inventory system with authentication, session tracking, and supervisor dashboard.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js**: 24
- **Frontend**: React 19 + Vite + Tailwind CSS (`artifacts/barcode-processor`)
- **Backend**: Express 5 + TypeScript (`artifacts/api-server`)
- **Database**: SQLite via `better-sqlite3` (file: `artifacts/api-server/data/estoque.db`)
- **Auth**: JWT (`jsonwebtoken`) + bcrypt (`bcryptjs`)
- **Excel**: ExcelJS
- **Build**: esbuild (api-server), Vite (frontend)

## Artifacts

### `artifacts/api-server` — Express API (port from `PORT` env)

Mounts all routes under `/api`.

**Routes:**
- `GET  /api/health` — health check
- `POST /api/auth/login` — login with username/password → JWT token + session
- `GET  /api/auth/me` — return authenticated user
- `POST /api/sessions/resume` — resume or create new session (`{ action: "resume"|"new" }`)
- `POST /api/sessions/select-organization` — assign/create the session for one organization
- `POST /api/sessions/encerrar` — finish the active session before changing organization
- `GET  /api/sessions/current` — active session for user
- `PUT  /api/sessions/ping` — update `last_update` (call on every scan)
- `POST /api/sessions/finalizar` — save counts + finalize session
- `GET  /api/admin/sessions` — all sessions with filters (admin only)
- `GET  /api/admin/sessions/:id` — session detail + counts (admin only)
- `GET  /api/admin/sessions/:id/export` — export session to Excel (admin only)
- `GET  /api/admin/users` — all users (admin only)
- `POST /api/estoque/upload` — import Excel reference file
- `GET  /api/estoque/comparar?sessionId=` — compare session vs Excel
- `GET  /api/estoque/exportar?sessionId=` — export session counts to Excel

**Database tables:**
- `users` — id, username, password (bcrypt), role (`user`|`admin`)
- `sessions` — id, user_id, organization, start_time, end_time, last_update, status (`active`|`finished`)
- `counts` — id, session_id, code, quantity (UNIQUE per session+code, upsert on re-scan)
- `itens` — legacy global aggregate (id, codigo, quantidade)

**Default admin user** seeded on first run: `admin` / `admin123`

**180-day cleanup** runs on every server startup. Legacy sessions may have a null organization and remain readable.

**Key files:**
- `src/lib/db.ts` — SQLite schema, seeding, all DB helpers
- `src/lib/jwtUtils.ts` — sign/verify JWT (`JWT_SECRET` env var, fallback default)
- `src/middlewares/authenticate.ts` — Bearer token middleware + `requireAdmin`
- `src/routes/auth.ts` — login, me
- `src/routes/sessionsRoute.ts` — session management
- `src/routes/adminRoute.ts` — supervisor dashboard
- `src/routes/estoque.ts` — Excel upload/compare/export (session-aware)
- `build.mjs` — esbuild config (externalizes `better-sqlite3`, `bcrypt`, etc.)

### `artifacts/barcode-processor` — React Frontend

**Pages:**
- `/login` — login form followed by organization selection; active sessions keep their organization locked
- `/` — main scanner (protected; requires login)
- `/admin` — supervisor dashboard (protected; requires admin role)

**Auth flow:**
- JWT stored in `localStorage` via `AuthContext`
- Every API call includes `Authorization: Bearer <token>`
- `session.id` is sent with finalizar/comparar/exportar calls

**Key files:**
- `src/lib/authContext.tsx` — React context: token, user, session, login/logout, authHeader()
- `src/lib/barcodeProcessor.ts` — parsing engine (no network calls, pure TS)
- `src/pages/login.tsx` — login + organization selection
- `src/pages/home.tsx` — scanner UI (session-aware, displays organization, pings API on each scan)
- `src/pages/admin.tsx` — supervisor dashboard with organization/status/user/date filters, detail view, export
- `src/App.tsx` — routing (wouter) with protected routes
- `src/index.css` — all styles (CSS custom properties prefixed `--nd-*`)

## Parsing Engine (`barcodeProcessor.ts`)

### Input sanitization
Leading non-alphanumeric characters are stripped before parsing (e.g. `P`, `]`, `««`).

### Exception codes (bypass parsing, code-only)
```
624-087J  624-085D  624-087H  624-087B  624-087D  586-008B  6631R-G007H
```
These are recognized as valid codes without quantity extraction.

### Supported formats (CODE_LENGTH = 11)
1. Exception code only → sets active code
2. `CODE;QTY` or `CODE;QTY;NOISE` → standard (extra semicolon parts ignored)
3. `CODE.NOISE.QTY` → dot-separated
4. `2000` (digits only) → quantity (requires active code set)
5. `0RJ6701C455` (exactly 11 alphanumeric) → code only
6. `0RJ6701C455YAI82HG002000` (concatenated, alphanumeric) → code+noise+trailing digits

### Single-item mode
First valid code locks the session. All other codes are rejected with a log entry.

## Session Flow

1. Login → check for existing active session
2. If `last_update < 2h` → frontend asks "Continue?" or "New session"
3. If `last_update >= 2h` → auto-finalize old, create new
4. Every scan calls `PUT /api/sessions/ping` (non-blocking)
5. Finalizar → saves to `counts` table + marks session `finished`

## Author
Lael Henrique Campos Dantas — LG Electronics Brasil Ltda · 2026
