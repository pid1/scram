/**
 * The price list.
 *
 * Every billable thing Cloudflare charges for is one `Product` here, and every
 * dimension it charges on is one `Meter`. Adding coverage for a product you
 * start using is meant to be a matter of appending an object to `CATALOG` --
 * no changes to the collector, the estimator or the kill switch.
 *
 * Rates verified against Cloudflare's published pricing on 2026-09-19. They
 * change. `RATES_VERIFIED_ON` is surfaced on the status page so a stale
 * catalog is visible rather than silently wrong.
 */

export const RATES_VERIFIED_ON = "2026-09-19";

/** How a meter's raw usage number is turned into a billable quantity. */
export interface Meter {
  /** Stable id, unique within the product. Used as the D1 breakdown key. */
  readonly id: string;
  readonly label: string;
  /** What the raw number counts, for the UI. */
  readonly unit: string;
  /**
   * Included in the plan each billing cycle, in `unit`. Usage at or below this
   * is free, so a healthy account estimates to exactly $0.
   */
  readonly included: number;
  /** Dollars per `per` units of billable usage above `included`. */
  readonly usd: number;
  readonly per: number;
  /**
   * Cloudflare rounds billable usage up to the next whole unit before applying
   * the rate (1,000,001 operations bills as 2,000,000). Where that is
   * documented, `roundUpTo` reproduces it so the estimate does not sit under
   * the real invoice.
   */
  readonly roundUpTo?: number;
}

export interface Product {
  readonly id: string;
  readonly label: string;
  /** Docs URL for the rates, shown in the UI so the numbers are checkable. */
  readonly docs: string;
  readonly meters: readonly Meter[];
}

export const CATALOG: readonly Product[] = [
  {
    id: "workers",
    label: "Workers",
    docs: "https://developers.cloudflare.com/workers/platform/pricing/#workers",
    meters: [
      {
        id: "requests",
        label: "Requests",
        unit: "requests",
        included: 10_000_000,
        usd: 0.3,
        per: 1_000_000,
      },
      {
        id: "cpu_ms",
        label: "CPU time",
        unit: "CPU-ms",
        included: 30_000_000,
        usd: 0.02,
        per: 1_000_000,
      },
    ],
  },
  {
    id: "d1",
    label: "D1",
    docs: "https://developers.cloudflare.com/d1/platform/pricing/",
    meters: [
      {
        id: "rows_read",
        label: "Rows read",
        unit: "rows",
        included: 25_000_000_000,
        usd: 0.001,
        per: 1_000_000,
      },
      {
        id: "rows_written",
        label: "Rows written",
        unit: "rows",
        included: 50_000_000,
        usd: 1.0,
        per: 1_000_000,
      },
      {
        id: "storage_gb_mo",
        label: "Storage",
        unit: "GB-mo",
        included: 5,
        usd: 0.75,
        per: 1,
      },
    ],
  },
  {
    id: "r2",
    label: "R2",
    docs: "https://developers.cloudflare.com/r2/pricing/",
    meters: [
      // Egress is free and deliberately absent: there is no such meter to bill.
      {
        id: "class_a",
        label: "Class A operations",
        unit: "operations",
        included: 1_000_000,
        usd: 4.5,
        per: 1_000_000,
        roundUpTo: 1_000_000,
      },
      {
        id: "class_b",
        label: "Class B operations",
        unit: "operations",
        included: 10_000_000,
        usd: 0.36,
        per: 1_000_000,
        roundUpTo: 1_000_000,
      },
      {
        id: "storage_gb_mo",
        label: "Storage",
        unit: "GB-mo",
        included: 10,
        usd: 0.015,
        per: 1,
        roundUpTo: 1,
      },
    ],
  },
  {
    id: "durable_objects",
    label: "Durable Objects",
    docs: "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    meters: [
      {
        id: "requests",
        label: "Requests",
        unit: "requests",
        included: 1_000_000,
        usd: 0.15,
        per: 1_000_000,
      },
      {
        id: "duration_gbs",
        label: "Compute duration",
        unit: "GB-s",
        included: 400_000,
        usd: 12.5,
        per: 1_000_000,
        roundUpTo: 1_000_000,
      },
      {
        id: "storage_gb_mo",
        label: "SQL storage",
        unit: "GB-mo",
        included: 1,
        usd: 0.2,
        per: 1,
      },
      {
        id: "rows_read",
        label: "SQL rows read",
        unit: "rows",
        included: 25_000_000_000,
        usd: 0.001,
        per: 1_000_000,
      },
      {
        id: "rows_written",
        label: "SQL rows written",
        unit: "rows",
        included: 50_000_000,
        usd: 1.0,
        per: 1_000_000,
      },
    ],
  },
  {
    id: "vectorize",
    label: "Vectorize",
    docs: "https://developers.cloudflare.com/vectorize/platform/pricing/",
    meters: [
      {
        id: "queried_dimensions",
        label: "Queried vector dimensions",
        unit: "dimensions",
        included: 50_000_000,
        usd: 0.01,
        per: 1_000_000,
      },
      {
        id: "stored_dimensions",
        label: "Stored vector dimensions",
        unit: "dimensions",
        included: 10_000_000,
        usd: 0.05,
        per: 100_000_000,
      },
    ],
  },
  {
    id: "queues",
    label: "Queues",
    docs: "https://developers.cloudflare.com/queues/platform/pricing/",
    meters: [
      {
        id: "operations",
        label: "Operations",
        unit: "operations",
        included: 1_000_000,
        usd: 0.4,
        per: 1_000_000,
      },
    ],
  },
] as const;

export function product(id: string): Product | undefined {
  return CATALOG.find((p) => p.id === id);
}

export function meter(productId: string, meterId: string): Meter | undefined {
  return product(productId)?.meters.find((m) => m.id === meterId);
}
