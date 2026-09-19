import { describe, expect, it } from "vitest";
import { CATALOG, meter } from "../../src/pricing/catalog.js";
import { estimate, priceMeter } from "../../src/pricing/estimate.js";

describe("priceMeter", () => {
  it("charges nothing inside the included allowance", () => {
    const m = meter("workers", "requests")!;
    expect(priceMeter(m, 0).usd).toBe(0);
    expect(priceMeter(m, 9_999_999).usd).toBe(0);
    expect(priceMeter(m, 10_000_000).usd).toBe(0);
  });

  it("charges the documented rate above it", () => {
    // Cloudflare's own worked example: 15M requests on Workers Paid = $1.50.
    const m = meter("workers", "requests")!;
    expect(priceMeter(m, 15_000_000).usd).toBeCloseTo(1.5, 6);
  });

  it("reproduces Cloudflare's CPU example", () => {
    // 7ms * 15M requests = 105M CPU-ms, less 30M included, at $0.02/M = $1.50.
    const m = meter("workers", "cpu_ms")!;
    expect(priceMeter(m, 105_000_000).usd).toBeCloseTo(1.5, 6);
  });

  it("reproduces Cloudflare's R2 Class B example", () => {
    // 10M reads/day * 30 days = 300M, less 10M included = 290M at $0.36/M.
    const m = meter("r2", "class_b")!;
    expect(priceMeter(m, 300_000_000).usd).toBeCloseTo(104.4, 6);
  });

  it("rounds billable usage up to the next unit where Cloudflare does", () => {
    // 1,000,001 billable Class A operations bills as 2,000,000.
    const m = meter("r2", "class_a")!;
    const { billable, usd } = priceMeter(m, 2_000_001);
    expect(billable).toBe(2_000_000);
    expect(usd).toBeCloseTo(9.0, 6);
  });

  it("does not round where Cloudflare bills fractionally", () => {
    const m = meter("workers", "requests")!;
    expect(priceMeter(m, 10_500_000).billable).toBe(500_000);
  });
});

describe("estimate", () => {
  it("is exactly zero for an idle account", () => {
    expect(estimate({}).totalUsd).toBe(0);
  });

  it("lists every meter in the catalog even when unused", () => {
    const total = CATALOG.reduce((n, p) => n + p.meters.length, 0);
    expect(estimate({}).lines).toHaveLength(total);
  });

  it("sums across products", () => {
    const e = estimate({
      workers: { requests: 15_000_000, cpu_ms: 105_000_000 },
      d1: { rows_written: 51_000_000 },
    });
    // $1.50 requests + $1.50 CPU + $1.00 for 1M rows written over the 50M included.
    expect(e.totalUsd).toBeCloseTo(4.0, 6);
    expect(e.byProduct.workers).toBeCloseTo(3.0, 6);
    expect(e.byProduct.d1).toBeCloseTo(1.0, 6);
  });

  it("reports utilisation so a meter can be watched before it costs anything", () => {
    const e = estimate({ workers: { requests: 5_000_000 } });
    const line = e.lines.find((l) => l.product === "workers" && l.meter === "requests")!;
    expect(line.utilisation).toBeCloseTo(0.5, 6);
    expect(line.usd).toBe(0);
  });
});
