#!/usr/bin/env bash
# Stage the static status page into dist/ and stamp it with the commit being
# deployed. wrangler.toml's [build] runs this before `wrangler dev` and
# `wrangler deploy`, so there is no separate step to forget.

set -euo pipefail

cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist
cp -R public/. dist/

# Identifies the deployed commit so .github/workflows/cf-fallback.yml can tell
# whether Cloudflare Workers Builds already published this tree. public/_headers
# serves it with Cache-Control: no-store.
#
# Read it from the checkout rather than the environment. Workers Builds sets
# WORKERS_CI_COMMIT_SHA to the *branch name* for a manually started build, and
# the fallback compares this value against github.sha -- so trusting the
# variable would leave the site looking permanently stale and make the
# fallback redeploy on every push, which is precisely what it exists to avoid.
sha=$(git rev-parse HEAD 2>/dev/null || echo "${WORKERS_CI_COMMIT_SHA:-${GITHUB_SHA:-local}}")
printf '%s\n' "$sha" > dist/.build-id

echo "staged dist/ at ${sha}"
