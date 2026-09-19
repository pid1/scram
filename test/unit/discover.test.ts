import { describe, expect, it } from "vitest";
import { discover } from "../../src/cf/discover.js";
import { readConfig } from "../../src/config.js";
import type { Env } from "../../src/types.js";

const env = {
  WARN_AT_USD: "5",
  SCRAM_AT_USD: "20",
  BILLING_CYCLE_DAY: "1",
  ARMED: "0",
  ACTIONS: "routes,custom_domains,crons,subdomain",
} as unknown as Env;

/** A CloudflareApi stand-in that answers from a fixed routing table. */
function fakeApi(routes: Record<string, unknown>) {
  return {
    get: async (path: string) => {
      for (const [pattern, value] of Object.entries(routes)) {
        if (path.startsWith(pattern)) return value;
      }
      throw new Error(`10007 not found: ${path}`);
    },
  } as never;
}

const ACCOUNT = "acct123";

describe("discover", () => {
  const api = () =>
    fakeApi({
      [`/accounts/${ACCOUNT}/workers/scripts`]: [
        { id: "scram" },
        { id: "tsundoku" },
        { id: "brand-new-project" },
      ],
      [`/zones?account.id=${ACCOUNT}`]: [{ id: "zone1", name: "example.com" }],
      "/zones/zone1/workers/routes": [
        { id: "r1", pattern: "example.com/*", script: "tsundoku" },
        { id: "r2", pattern: "scram.example.com/*", script: "scram" },
        { id: "r3", pattern: "new.example.com/*", script: "brand-new-project" },
      ],
      [`/accounts/${ACCOUNT}/workers/domains`]: [
        {
          id: "d1",
          hostname: "tsundoku.example.com",
          service: "tsundoku",
          zone_id: "zone1",
          zone_name: "example.com",
          environment: "production",
        },
      ],
      [`/accounts/${ACCOUNT}/workers/scripts/tsundoku/schedules`]: {
        schedules: [{ cron: "17 4 * * *" }],
      },
      [`/accounts/${ACCOUNT}/workers/scripts/scram/schedules`]: {
        schedules: [{ cron: "*/15 * * * *" }],
      },
      [`/accounts/${ACCOUNT}/workers/scripts/tsundoku/subdomain`]: { enabled: true },
    });

  it("never returns a target belonging to scram itself", async () => {
    const inv = await discover(api(), ACCOUNT, readConfig(env));
    expect(inv.targets.some((t) => t.script === "scram")).toBe(false);
  });

  it("picks up a project it has never been told about", async () => {
    const inv = await discover(api(), ACCOUNT, readConfig(env));
    const found = inv.targets.find((t) => t.script === "brand-new-project");
    expect(found?.label).toBe("new.example.com/*");
  });

  it("honours PROTECT for other scripts", async () => {
    const config = readConfig({ ...env, PROTECT: "tsundoku" } as Env);
    const inv = await discover(api(), ACCOUNT, config);
    expect(inv.targets.some((t) => t.script === "tsundoku")).toBe(false);
    expect(inv.targets.some((t) => t.script === "brand-new-project")).toBe(true);
  });

  it("only collects the action kinds that are enabled", async () => {
    const config = readConfig({ ...env, ACTIONS: "crons" } as Env);
    const inv = await discover(api(), ACCOUNT, config);
    expect(inv.targets.every((t) => t.kind === "crons")).toBe(true);
  });

  it("captures enough to undo a route", async () => {
    const inv = await discover(api(), ACCOUNT, readConfig(env));
    const route = inv.targets.find((t) => t.kind === "routes")!;
    expect(route.undo).toMatchObject({ zoneId: "zone1", pattern: expect.any(String) });
    expect(route.apply).toMatchObject({ zoneId: "zone1", routeId: expect.any(String) });
  });

  it("does not record a missing workers.dev subdomain as a failure", async () => {
    const inv = await discover(api(), ACCOUNT, readConfig(env));
    expect(Object.keys(inv.failures).filter((k) => k.startsWith("subdomain:"))).toHaveLength(0);
  });

  it("reports a discovery step that genuinely failed", async () => {
    const broken = fakeApi({
      [`/accounts/${ACCOUNT}/workers/scripts`]: [{ id: "tsundoku" }],
      // No zones entry, so the zone lookup throws.
    });
    const inv = await discover(broken, ACCOUNT, readConfig(env));
    expect(inv.failures.zones).toBeDefined();
  });
});
