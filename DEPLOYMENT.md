# Maal Help — Deployment

Maal Help ships as **one Node.js service** that serves both the API and the built web app (PWA), plus **managed PostgreSQL 15+** and optional S3-compatible storage. No Redis or separate worker is needed: background jobs run in-process on a PostgreSQL-backed queue.

## 1. Requirements

- Node.js 20.11+ (tested on Node 24)
- PostgreSQL 15+ (managed: Neon, Supabase, AWS RDS, Azure, DigitalOcean, Render…). Version 15 is needed for `UNIQUE NULLS NOT DISTINCT`
- HTTPS termination (a load balancer or platform proxy). The app sets `trustProxy`
- Optional: S3-compatible bucket for uploaded documents (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
- Optional: Mistral API key

## 2. Build

```bash
npm ci
```
```bash
npm run build
```
This produces `dist/web` (static PWA with service worker) and `dist/server/index.js`.

## 3. Configure (production)

Set these as platform secrets, **never** in source control:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` / `HOST` | e.g. `8080` / `0.0.0.0` |
| `APP_ORIGIN` | Public URL, e.g. `https://app.maalhelp.example` (used for CSRF origin checks) |
| `DATABASE_URL` | Managed PostgreSQL connection string with TLS |
| `SESSION_SECRET` | 32+ random bytes, base64 |
| `ENCRYPTION_KEY` | 32 random bytes, base64 (encrypts integration credentials) |
| `COOKIE_SECURE` | `true` |
| `SEED_DEMO` | `false` |
| `MISTRAL_API_KEY` | Optional; server-only |
| `STORAGE_DRIVER` + `S3_*` | `s3` and bucket credentials (local disk is not durable on most PaaS) |
| `EMAIL_PROVIDER`, `SMTP_URL`, `EMAIL_FROM` | Real email delivery (`log` only writes to the log) |

Generate secrets with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**The server refuses to start in production** if `DATABASE_URL` is missing, `SESSION_SECRET` is short or still the sample value, `ENCRYPTION_KEY` is missing, or `COOKIE_SECURE` is not `true`.

## 4. Run

```bash
npm start
```
On start, the server applies pending migrations, ensures the platform reference data exists (plans, feature flags), starts the API and the job worker. Health check: `GET /api/v1/health` returns `{"success":true,"data":{"status":"ok"}}` once the database answers.

### Platform admin account

In production the server never creates the demo platform admin. Create your own (or reset its password) with credentials supplied through the environment:

```bash
PLATFORM_ADMIN_EMAIL=ops@yourcompany.com PLATFORM_ADMIN_PASSWORD='<strong password>' npm run admin:create
```

From a built image without dev tools: `node dist/server/create-admin-cli.js` with the same variables.

### Docker (example)

```dockerfile
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/drizzle ./server/drizzle
COPY --from=build /app/web/public/brand ./web/public/brand
COPY package.json ./
EXPOSE 8080
CMD ["node", "dist/server/index.js"]
```
*(This Dockerfile is a template; it has not been built or run in this workspace.)*

## 5. Scaling notes

- The job queue uses `FOR UPDATE SKIP LOCKED`, so several instances can share the work safely. Set `JOBS_ENABLED=false` on web-only instances if you prefer a dedicated worker.
- Rate limiting is in-memory per instance. Behind several instances, apply limits at the load balancer too.
- Sessions are stored in PostgreSQL, so no sticky sessions are needed.
- PGlite is for development and tests only: single process, no network access, and vulnerable to corruption on hard kills.

## 6. Security checklist before go-live

- [ ] HTTPS only; `COOKIE_SECURE=true`; HSTS is enabled automatically in production
- [ ] Unique `SESSION_SECRET` and `ENCRYPTION_KEY` stored in a secret manager
- [ ] Own platform admin created with `npm run admin:create`; demo data absent (`SEED_DEMO=false`)
- [ ] Database backups and point-in-time recovery enabled and a restore tested
- [ ] `MISTRAL_API_KEY` only in server secrets; usage limits set per plan
- [ ] Log retention configured; logs redact cookies and authorization headers by default
- [ ] Penetration test and dependency audit (`npm audit`) reviewed
- [ ] Real integration adapters implemented and tested before enabling them (the MVP ships **mock** adapters)

## 7. Upgrades

1. Back up the database.
2. Deploy the new build. Migrations run automatically on start.
3. Check `/api/v1/health` and **Platform → System health**.

Migrations only move forward. Restore from backup to roll back a schema change.

## 8. Render (hosted demo)

| Setting | Value |
|---|---|
| Runtime / region | Node · same region as the database (internal URL) |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/v1/health` |

Environment: `NODE_ENV=production`, `NODE_VERSION=22`, `DATABASE_URL` (the database's **internal** URL, pasted in the dashboard), `SESSION_SECRET`, `ENCRYPTION_KEY`, `COOKIE_SECURE=true`, `APP_ORIGIN=https://<service>.onrender.com`.

**Sharing a database with another app:** set `DB_SCHEMA=maalhelp`. Maal Help then creates and uses only that Postgres schema (tables, migrations table and triggers), and `db:reset` drops only that schema, never `public`.

**Hosted demo data (staging only):** `SEED_DEMO=true`, `ALLOW_DEMO_SEED_IN_PRODUCTION=true` and a unique `DEMO_PASSWORD`. The demo company is built in the background after the server starts (allow ~10–15 minutes). `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` create or update the Super Admin at start. Remove these variables for real use.
