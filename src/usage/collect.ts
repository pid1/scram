import type { GraphQLClient, Range } from "./graphql.js";
import type { UsageMap } from "../types.js";

/**
 * R2 operation classes, from R2's pricing page. Anything Cloudflare adds that
 * is not listed here is counted as Class A -- the expensive class -- so a new
 * operation type errs toward over-estimating rather than under-estimating.
 * DeleteObject, DeleteBucket and AbortMultipartUpload are free.
 */
const R2_CLASS_B = new Set([
  "HeadBucket",
  "HeadObject",
  "GetObject",
  "UsageSummary",
  "GetBucketEncryption",
  "GetBucketLocation",
  "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

/** Durable Objects bill duration at a fixed 128 MB per object. */
const DO_GB_PER_OBJECT = 128 / 1024;

const GB = 1024 ** 3;

/**
 * A GB-month accrues as the daily peak, averaged over a 30-day month. Summing
 * daily peaks and dividing by 30 gives the amount accrued so far this cycle,
 * which is what the invoice will show if usage stops now.
 */
export function gbMonths(dailyPeakBytes: number[]): number {
  return dailyPeakBytes.reduce((acc, b) => acc + b / GB, 0) / 30;
}

/** Which R2 price class an operation falls into. Exported for testing. */
export function r2Class(actionType: string): "a" | "b" | "free" {
  if (R2_FREE.has(actionType)) return "free";
  if (R2_CLASS_B.has(actionType)) return "b";
  return "a";
}

export interface Collector {
  readonly product: string;
  collect(gql: GraphQLClient, r: Range): Promise<Record<string, number>>;
}

/**
 * One collector per product in the catalog.
 *
 * Each is independent and independently fallible: a dataset that a token
 * cannot read, or that Cloudflare renames, blinds exactly one product instead
 * of the whole estimate. `collectAll` reports which ones failed.
 */
export const COLLECTORS: readonly Collector[] = [
  {
    product: "workers",
    async collect(gql, r) {
      const d = await gql.account<{
        workersInvocationsAdaptive: { sum: { requests: number; cpuTimeUs: number } }[];
      }>(`workersInvocationsAdaptive(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { requests cpuTimeUs } }`);

      let requests = 0;
      let cpuUs = 0;
      for (const row of d.workersInvocationsAdaptive) {
        requests += row.sum.requests ?? 0;
        cpuUs += row.sum.cpuTimeUs ?? 0;
      }
      return { requests, cpu_ms: cpuUs / 1000 };
    },
  },

  {
    product: "d1",
    async collect(gql, r) {
      const d = await gql.account<{
        d1AnalyticsAdaptiveGroups: { sum: { rowsRead: number; rowsWritten: number } }[];
        d1StorageAdaptiveGroups: {
          max: { databaseSizeBytes: number };
          dimensions: { date: string; databaseId: string };
        }[];
      }>(`d1AnalyticsAdaptiveGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { rowsRead rowsWritten } }
          d1StorageAdaptiveGroups(
            limit: 10000,
            filter: { date_geq: "${r.sinceDate}", date_leq: "${r.untilDate}" }
          ) { max { databaseSizeBytes } dimensions { date databaseId } }`);

      let rowsRead = 0;
      let rowsWritten = 0;
      for (const row of d.d1AnalyticsAdaptiveGroups) {
        rowsRead += row.sum.rowsRead ?? 0;
        rowsWritten += row.sum.rowsWritten ?? 0;
      }

      // Storage bills on the sum across every database in the account, so the
      // daily peak is the sum of each database's peak that day.
      const perDay = new Map<string, number>();
      for (const row of d.d1StorageAdaptiveGroups) {
        const day = row.dimensions.date;
        perDay.set(day, (perDay.get(day) ?? 0) + (row.max.databaseSizeBytes ?? 0));
      }

      return {
        rows_read: rowsRead,
        rows_written: rowsWritten,
        storage_gb_mo: gbMonths([...perDay.values()]),
      };
    },
  },

  {
    product: "r2",
    async collect(gql, r) {
      const d = await gql.account<{
        r2OperationsAdaptiveGroups: {
          sum: { requests: number };
          dimensions: { actionType: string };
        }[];
        r2StorageAdaptiveGroups: {
          max: { payloadSize: number; metadataSize: number };
          dimensions: { date: string; bucketName: string };
        }[];
      }>(`r2OperationsAdaptiveGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { requests } dimensions { actionType } }
          r2StorageAdaptiveGroups(
            limit: 10000,
            filter: { date_geq: "${r.sinceDate}", date_leq: "${r.untilDate}" }
          ) { max { payloadSize metadataSize } dimensions { date bucketName } }`);

      let classA = 0;
      let classB = 0;
      for (const row of d.r2OperationsAdaptiveGroups) {
        const n = row.sum.requests ?? 0;
        const cls = r2Class(row.dimensions.actionType);
        if (cls === "free") continue;
        if (cls === "b") classB += n;
        else classA += n;
      }

      const perDay = new Map<string, number>();
      for (const row of d.r2StorageAdaptiveGroups) {
        const day = row.dimensions.date;
        const bytes = (row.max.payloadSize ?? 0) + (row.max.metadataSize ?? 0);
        perDay.set(day, (perDay.get(day) ?? 0) + bytes);
      }

      return {
        class_a: classA,
        class_b: classB,
        storage_gb_mo: gbMonths([...perDay.values()]),
      };
    },
  },

  {
    product: "durable_objects",
    async collect(gql, r) {
      const d = await gql.account<{
        durableObjectsInvocationsAdaptiveGroups: { sum: { requests: number } }[];
        durableObjectsPeriodicGroups: {
          sum: { activeTime: number; rowsRead: number; rowsWritten: number };
        }[];
        durableObjectsSqlStorageGroups: {
          max: { storedBytes: number };
          dimensions: { date: string };
        }[];
      }>(`durableObjectsInvocationsAdaptiveGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { requests } }
          durableObjectsPeriodicGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { activeTime rowsRead rowsWritten } }
          durableObjectsSqlStorageGroups(
            limit: 10000,
            filter: { date_geq: "${r.sinceDate}", date_leq: "${r.untilDate}" }
          ) { max { storedBytes } dimensions { date } }`);

      let requests = 0;
      for (const row of d.durableObjectsInvocationsAdaptiveGroups) {
        requests += row.sum.requests ?? 0;
      }

      let activeTimeUs = 0;
      let rowsRead = 0;
      let rowsWritten = 0;
      for (const row of d.durableObjectsPeriodicGroups) {
        activeTimeUs += row.sum.activeTime ?? 0;
        rowsRead += row.sum.rowsRead ?? 0;
        rowsWritten += row.sum.rowsWritten ?? 0;
      }

      const perDay = new Map<string, number>();
      for (const row of d.durableObjectsSqlStorageGroups) {
        const day = row.dimensions.date;
        perDay.set(day, (perDay.get(day) ?? 0) + (row.max.storedBytes ?? 0));
      }

      return {
        requests,
        duration_gbs: (activeTimeUs / 1_000_000) * DO_GB_PER_OBJECT,
        rows_read: rowsRead,
        rows_written: rowsWritten,
        storage_gb_mo: gbMonths([...perDay.values()]),
      };
    },
  },

  {
    product: "vectorize",
    async collect(gql, r) {
      const d = await gql.account<{
        vectorizeV2QueriesAdaptiveGroups: { sum: { queriedVectorDimensions: number } }[];
        vectorizeV2StorageAdaptiveGroups: {
          max: { storedVectorDimensions: number };
          dimensions: { date: string };
        }[];
      }>(`vectorizeV2QueriesAdaptiveGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { queriedVectorDimensions } }
          vectorizeV2StorageAdaptiveGroups(
            limit: 10000,
            filter: { date_geq: "${r.sinceDate}", date_leq: "${r.untilDate}" }
          ) { max { storedVectorDimensions } dimensions { date } }`);

      let queried = 0;
      for (const row of d.vectorizeV2QueriesAdaptiveGroups) {
        queried += row.sum.queriedVectorDimensions ?? 0;
      }
      // Stored dimensions bill on the current figure, not an accrual.
      const stored = Math.max(
        0,
        ...d.vectorizeV2StorageAdaptiveGroups.map((x) => x.max.storedVectorDimensions ?? 0),
      );
      return { queried_dimensions: queried, stored_dimensions: stored };
    },
  },

  {
    product: "queues",
    async collect(gql, r) {
      const d = await gql.account<{
        queueMessageOperationsAdaptiveGroups: { sum: { billableOperations: number } }[];
      }>(`queueMessageOperationsAdaptiveGroups(
            limit: 10000,
            filter: { datetime_geq: "${r.sinceIso}", datetime_leq: "${r.untilIso}" }
          ) { sum { billableOperations } }`);

      let operations = 0;
      for (const row of d.queueMessageOperationsAdaptiveGroups) {
        operations += row.sum.billableOperations ?? 0;
      }
      return { operations };
    },
  },
];

export interface Collected {
  readonly usage: UsageMap;
  /** Products whose collector threw, with the reason. */
  readonly failures: Readonly<Record<string, string>>;
  /** True when at least one collector succeeded. */
  readonly anySucceeded: boolean;
}

export async function collectAll(gql: GraphQLClient, r: Range): Promise<Collected> {
  const usage: UsageMap = {};
  const failures: Record<string, string> = {};

  const results = await Promise.allSettled(
    COLLECTORS.map(async (c) => [c.product, await c.collect(gql, r)] as const),
  );

  for (let i = 0; i < results.length; i++) {
    const res = results[i]!;
    if (res.status === "fulfilled") {
      const [product, values] = res.value;
      usage[product] = values;
    } else {
      failures[COLLECTORS[i]!.product] = String(res.reason?.message ?? res.reason);
    }
  }

  return {
    usage,
    failures,
    anySucceeded: Object.keys(usage).length > 0,
  };
}
