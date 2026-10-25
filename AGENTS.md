# AGENTS.md

## Sadr

### Build and test
- Run `npm ci`, then `npm run typecheck` and `npm test`. Passing means tsc exits 0 and every vitest test passes (4 files, 38 tests on 2026-10-25). The suite runs inside workerd through @cloudflare/vitest-plugin and needs no Cloudflare account or secrets.
- `npx --no-install wrangler dev` starts the app locally against a local D1 database. `GET /` returns 200 and `GET /api/status` returns 401 without the admin token. Scheduled triggers do not fire in local development.
- Never run `npm run deploy`, `npm run db:migrate` or `scripts/setup.sh` for verification. They write to the Cloudflare account.

### Deploys outside CI
- Cloudflare Workers Builds deploys main on every push, from settings in the Cloudflare dashboard. `.github/workflows/cf-fallback.yml` deploys only when the live site still serves an older commit, read from `/.build-id`.
