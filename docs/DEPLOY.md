# Clearview OD — staging deploy (hand-holding manual)

A long-lived, clickable **staging** environment on **synthetic data** — no GitHub Actions, no real PHI.

```
Browser ── https://<web>.vercel.app ──▶  Vercel (Next.js, packages/web)
                                             │  NEXT_PUBLIC_API_BASE_URL
                                             ▼
                       https://<api>.onrender.com  ──▶ Render (Docker, packages/api)
                                             │  APP_DATABASE_URL (clearview_login, non-superuser)
                                             ▼
                          Managed Postgres + pgvector (Neon or Supabase)
```

- **Web → Vercel** (connects the repo, auto-deploys). **API → Render** (Docker, connects the repo). **DB → Neon** (managed Postgres w/ pgvector). All configured in each platform's dashboard — nothing is a GitHub workflow.
- **No prod downgrade.** The API runs `NODE_ENV=production`: it connects as the non-superuser **`clearview_login`** (`APP_DATABASE_URL`), the boot self-check aborts if that role can bypass RLS, and client-supplied `X-Tenant-Id`/`staffHandle` are ignored. The only "staging-ness" is a password-gated manager login + seeded synthetic data.

---

## 0. Founder secrets checklist (what to paste where)

| Platform | Key | Value |
|---|---|---|
| **Neon** | (project) | Create a Postgres project; copy the **owner** connection string + the **host**. Enable pgvector (step 1). |
| **Render** (API env) | `DATABASE_URL` | Neon **owner** string (migrations only), `?sslmode=require`. |
| | `APP_DATABASE_URL` | `postgresql://clearview_login:clearview_login_dev@<neon-host>/<db>?sslmode=require` (the app runtime role). |
| | `DATABASE_SSL` | `true` |
| | `NODE_ENV` | `production` |
| | `CORS_ORIGIN` | your Vercel URL, e.g. `https://clearview-od.vercel.app` |
| | `STAGING_LOGIN_ENABLED` | `true` |
| | `STAGING_LOGIN_PASSWORD` | a long random string (this is the staging manager password) |
| | `STAGING_TENANT_ID` | `11111111-1111-1111-1111-111111111111` (seeded Tenant A) |
| **Vercel** (web env) | `NEXT_PUBLIC_API_BASE_URL` | your Render API URL, e.g. `https://clearview-od-api.onrender.com` |
| | `NEXT_PUBLIC_STAGING` | `true` |

> `render.yaml` and `packages/web/vercel.json` already declare the non-secret settings; you only paste the values above. `PORT` is injected by Render automatically.

---

## 1. Database — Neon (managed Postgres + pgvector)

1. Create a Neon project (any region). Copy the **connection string** (this is the owner role) and note the host.
2. Enable pgvector — in the Neon SQL editor: `CREATE EXTENSION IF NOT EXISTS vector;` (migration `0000` also does this defensively).
3. That's it — the migration creates the `clearview_app` + `clearview_login` roles and all tables.

## 2. Migrate + seed the hosted DB (run once)

From any machine with this repo checked out (uses the owner `DATABASE_URL`):

```bash
pnpm install
export DATABASE_URL='postgresql://<owner>:<pw>@<neon-host>/<db>?sslmode=require'
pnpm --filter @clearview/api db:migrate    # creates roles + tables (idempotent)
pnpm --filter @clearview/api db:seed        # synthetic data for two tenants
```

Confirm the app role exists and is **not** privileged (the API refuses to boot otherwise):

```bash
psql "$DATABASE_URL" -c "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='clearview_login';"
# → clearview_login | f | f
```

> **Rotate the app password (recommended):** `ALTER ROLE clearview_login PASSWORD '<strong>';` then use that in `APP_DATABASE_URL`. The migration ships a dev default (`clearview_login_dev`) that is fine for a synthetic-data staging DB but should not be reused for anything real.
>
> Migrations also run automatically on Render via the pre-deploy command (`node db/migrate.mjs`) if your instance supports it; seed stays a one-off (above).

## 3. API — Render (Docker)

1. New → **Blueprint**, connect this repo. Render reads `render.yaml` and proposes the `clearview-od-api` Docker service.
2. Fill the `sync:false` env vars from the checklist (`DATABASE_URL`, `APP_DATABASE_URL`, `CORS_ORIGIN`, `STAGING_LOGIN_PASSWORD`).
3. Deploy. Verify:
   - `GET https://<api>.onrender.com/health` → `200`.
   - Logs show `API listening on :<port> (NODE_ENV=production)` and **no** "Refusing to start" (the boot self-check passed → connected as the non-superuser role).
4. **Free tier / no pre-deploy?** The `preDeployCommand` needs a paid instance. If unavailable, migrations were already applied in step 2, so just deploy; for later schema changes run `node db/migrate.mjs` from a Render one-off shell (with `DATABASE_URL` set) or re-run step 2 locally.

## 4. Web — Vercel (Next.js)

1. New Project → import this repo.
2. **Root Directory = `packages/web`**, and enable **"Include files outside of the Root Directory in the Build Step"** (the monorepo build runs `cd ../..` — see `packages/web/vercel.json`).
3. Env vars: `NEXT_PUBLIC_API_BASE_URL=https://<api>.onrender.com` and `NEXT_PUBLIC_STAGING=true`.
4. Deploy. Copy the resulting URL (e.g. `https://clearview-od.vercel.app`).

## 5. Wire CORS

Set Render's `CORS_ORIGIN` to the exact Vercel URL from step 4 and redeploy the API (or just save — Render redeploys). The web authenticates cross-origin with a **Bearer token** + `?session=` on SSE, so the API must allow that specific origin.

## 6. Verify the DoD

Open `https://<web>.vercel.app`:
- [ ] Sign in with the staging password → the command center loads **real** data (from Neon, not mock).
- [ ] Six domain tiles show live status; SSE updates in real time; switch 中 / EN / 日.
- [ ] Approve a low-risk cue → **executed** + the target object changes; approve a high-risk cue → **blocked, not executed**; **undo** an executed one → reverts.
- [ ] Click a tile → domain drill-down with the object timeline (e.g. Room-3 conflict → verified).
- [ ] `GET /health` is green; API logs confirm the non-superuser role + no self-report acceptance.

---

## Security notes

- **Non-superuser at runtime.** `APP_DATABASE_URL` must be the `clearview_login` role. `assertRuntimeRoleSafe()` aborts boot if it is a superuser / BYPASSRLS / table owner.
- **Staging login is not dev-login.** `/auth/manager/dev-login` still returns 404 under `NODE_ENV=production`. The staging login is a separate, env-gated, password-protected endpoint (`STAGING_LOGIN_ENABLED` + `STAGING_LOGIN_PASSWORD`, constant-time compared); leave it disabled on any real prod tenant.
- **Synthetic data only** — never load real PHI into staging.

## Out of scope (later)

Real WeChat Mini Program client (AppID + ICP), real external integrations (supplier / claim / patient push / payment), custom domain + ICP filing, white-label / self-serve onboarding, cross-store benchmarks.

## Troubleshooting

- **API won't boot: "APP_DATABASE_URL … required in production"** → set `APP_DATABASE_URL` (the clearview_login connection).
- **API won't boot: "Refusing to start: DB role … is privileged"** → `APP_DATABASE_URL` points at the owner/superuser; use `clearview_login`.
- **DB connect error / SSL** → ensure `?sslmode=require` in the URLs and `DATABASE_SSL=true`.
- **`clearview_login` can't authenticate on the platform** → some providers gate SQL-created login roles; rotate its password (`ALTER ROLE …`) and/or create it via the provider's role UI, then point `APP_DATABASE_URL` at it. It must remain non-superuser, non-BYPASSRLS.
- **Web shows "offline" / CORS error** → `NEXT_PUBLIC_API_BASE_URL` must be the API origin, and Render `CORS_ORIGIN` must be the exact Vercel origin.
- **Login fails on staging** → `NEXT_PUBLIC_STAGING=true` (web) and `STAGING_LOGIN_ENABLED=true` + matching `STAGING_LOGIN_PASSWORD` (API).
