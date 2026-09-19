import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// The suite runs inside workerd so the D1 binding behaves as it will in
// production. It needs no Cloudflare account, no real database_id and no
// token: the pricing, cycle and policy logic under test is all pure, and the
// D1 tests run against miniflare's local database.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-22",
        d1Databases: ["DB"],
        bindings: {
          CF_API_TOKEN: "test-token",
          ADMIN_TOKEN: "test-admin-token",
          CF_ACCOUNT_ID: "test-account",
          WARN_AT_USD: "5",
          SCRAM_AT_USD: "20",
          BILLING_CYCLE_DAY: "1",
          ARMED: "0",
          PROTECT: "",
          ACTIONS: "routes,custom_domains,crons,subdomain",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["test/unit/**/*.test.ts"],
  },
});
