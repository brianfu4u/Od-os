# Staging Deploy Status

- 2026-07-10: staging (Neon + Render + Vercel) live; forcing a fresh Vercel build of `main` so the web serves the current code, where `API_BASE` strips trailing slashes (config.ts) — fixes the `//auth` login 404 from a stale build.
- API: https://od-os.onrender.com (/health OK, runs as non-superuser clearview_login).
- Web: https://od-os-web.vercel.app (auto-deploys on push to main).
