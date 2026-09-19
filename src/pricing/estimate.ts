import { CATALOG, type Meter, type Product } from "./catalog.js";
import type { UsageMap } from "../types.js";

export interface MeterLine {
  readonly product: string;
  readonly productLabel: string;
  readonly meter: string;
  readonly meterLabel: string;
  readonly unit: string;
  /** What was actually observed this cycle. */
  readonly used: number;
  readonly included: number;
  /** Observed minus included, floored at zero, then rounded up per the rate. */
  readonly billable: number;
  readonly usd: number;
  /** used / included, for the "how close are we" bar. Infinity when included is 0. */
  readonly utilisation: number;
}

export interface Estimate {
  readonly totalUsd: number;
  readonly lines: readonly MeterLine[];
  /** Products with usage above zero, cheapest-first ordering left to the caller. */
  readonly byProduct: Readonly<Record<string, number>>;
}

export function priceMeter(m: Meter, used: number): { billable: number; usd: number } {
  const over = Math.max(0, used - m.included);
  if (over === 0) return { billable: 0, usd: 0 };
  // Cloudflare rounds the billable quantity up to the next whole unit before
  // applying the rate, where it documents doing so.
  const billable = m.roundUpTo ? Math.ceil(over / m.roundUpTo) * m.roundUpTo : over;
  return { billable, usd: (billable / m.per) * m.usd };
}

function lineFor(p: Product, m: Meter, used: number): MeterLine {
  const { billable, usd } = priceMeter(m, used);
  return {
    product: p.id,
    productLabel: p.label,
    meter: m.id,
    meterLabel: m.label,
    unit: m.unit,
    used,
    included: m.included,
    billable,
    usd,
    utilisation: m.included > 0 ? used / m.included : used > 0 ? Infinity : 0,
  };
}

/**
 * Turn observed usage into dollars.
 *
 * Meters the collector returned no number for are treated as zero rather than
 * skipped, so the status page shows the full price list and it is obvious
 * which products are being watched. A product scram cannot see at all is a
 * blind spot, and a blind spot should be visible.
 */
export function estimate(usage: UsageMap): Estimate {
  const lines: MeterLine[] = [];
  const byProduct: Record<string, number> = {};

  for (const p of CATALOG) {
    let productUsd = 0;
    for (const m of p.meters) {
      const used = usage[p.id]?.[m.id] ?? 0;
      const line = lineFor(p, m, used);
      lines.push(line);
      productUsd += line.usd;
    }
    byProduct[p.id] = round(productUsd);
  }

  const totalUsd = round(lines.reduce((acc, l) => acc + l.usd, 0));
  return { totalUsd, lines, byProduct };
}

/** Half-cent precision is the most the upstream numbers can honestly support. */
function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
