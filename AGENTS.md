# AGENTS.md

## Homepage

The README is scram's homepage and its documentation. The repository's GitHub "website" field points at it (https://github.com/pid1/scram#readme). There is no GitHub Pages site or separate landing page, and none should be added. Detail goes in other Markdown files the README links to, such as PLAN.md. When a change alters what scram does or how it's set up, update the README in the same PR.

## Sadr

### Build and test
- Run `npm ci`, then `npm run typecheck` and `npm test`. Passing means tsc exits 0 and every vitest test passes (4 files, 38 tests on 2026-10-25). The suite runs inside workerd through @cloudflare/vitest-plugin and needs no Cloudflare account or secrets.
- `npx --no-install wrangler dev` starts the app locally against a local D1 database. `GET /` returns 200 and `GET /api/status` returns 401 without the admin token. Scheduled triggers do not fire in local development.
- Never run `npm run deploy`, `npm run db:migrate` or `scripts/setup.sh` for verification. They write to the Cloudflare account.

### Toolchain
- CI and the fallback deploy pin Node 26.13.0 (npm 11.20.0) in actions/setup-node. That npm reads `min-release-age=7` from `.npmrc`, and `npm outdated` honors it.

### Deploys outside CI
- Cloudflare Workers Builds deploys main on every push, from settings in the Cloudflare dashboard. `.github/workflows/cf-fallback.yml` deploys only when the live site still serves an older commit, read from `/.build-id`.
