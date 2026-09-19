import { describe, expect, it } from "vitest";
import { cycleStart, readConfig, SELF } from "../../src/config.js";
import type { Env } from "../../src/types.js";

const base = {
  WARN_AT_USD: "5",
  SCRAM_AT_USD: "20",
  BILLING_CYCLE_DAY: "1",
  ARMED: "0",
  ACTIONS: "routes,custom_domains,crons,subdomain",
} as unknown as Env;

describe("readConfig", () => {
  it("always protects scram itself", () => {
    expect(readConfig(base).protect.has(SELF)).toBe(true);
  });

  it("protects scram even when PROTECT is set to something else", () => {
    const c = readConfig({ ...base, PROTECT: "rally,tsundoku" } as Env);
    expect(c.protect.has(SELF)).toBe(true);
    expect(c.protect.has("rally")).toBe(true);
    expect(c.protect.has("tsundoku")).toBe(true);
  });

  it("treats ARMED as off unless it is exactly 1", () => {
    expect(readConfig(base).armed).toBe(false);
    expect(readConfig({ ...base, ARMED: "true" } as Env).armed).toBe(false);
    expect(readConfig({ ...base, ARMED: "yes" } as Env).armed).toBe(false);
    expect(readConfig({ ...base, ARMED: "1" } as Env).armed).toBe(true);
  });

  it("drops unknown action kinds rather than failing open on them", () => {
    const c = readConfig({ ...base, ACTIONS: "routes,delete_everything" } as Env);
    expect(c.actions).toEqual(["routes"]);
  });

  it("falls back to every action when ACTIONS is empty", () => {
    const c = readConfig({ ...base, ACTIONS: "" } as Env);
    expect(c.actions).toContain("routes");
    expect(c.actions).toContain("crons");
  });

  it("rejects a threshold that could never trip", () => {
    expect(() => readConfig({ ...base, SCRAM_AT_USD: "0" } as Env)).toThrow();
  });

  it("rejects a cycle day that would skip months", () => {
    expect(() => readConfig({ ...base, BILLING_CYCLE_DAY: "31" } as Env)).toThrow();
  });
});

describe("cycleStart", () => {
  it("uses this month once the cycle day has passed", () => {
    const now = new Date("2026-09-19T10:00:00Z");
    expect(cycleStart(now, 12).toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("falls back to last month before the cycle day", () => {
    const now = new Date("2026-09-05T10:00:00Z");
    expect(cycleStart(now, 12).toISOString()).toBe("2026-08-12T00:00:00.000Z");
  });

  it("handles the cycle day being today", () => {
    const now = new Date("2026-09-12T00:00:01Z");
    expect(cycleStart(now, 12).toISOString()).toBe("2026-09-12T00:00:00.000Z");
  });

  it("rolls across a year boundary", () => {
    const now = new Date("2026-01-03T10:00:00Z");
    expect(cycleStart(now, 15).toISOString()).toBe("2025-12-15T00:00:00.000Z");
  });
});
