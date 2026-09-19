import { describe, expect, it } from "vitest";
import { gbMonths, r2Class } from "../../src/usage/collect.js";
import { range } from "../../src/usage/graphql.js";

const GB = 1024 ** 3;

describe("r2Class", () => {
  it("classifies the documented Class A operations", () => {
    for (const op of ["PutObject", "ListObjects", "CreateMultipartUpload", "UploadPart", "CopyObject"]) {
      expect(r2Class(op)).toBe("a");
    }
  });

  it("classifies the documented Class B operations", () => {
    for (const op of ["GetObject", "HeadObject", "HeadBucket", "GetBucketCors"]) {
      expect(r2Class(op)).toBe("b");
    }
  });

  it("treats deletes and aborts as free", () => {
    for (const op of ["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]) {
      expect(r2Class(op)).toBe("free");
    }
  });

  it("errs toward the expensive class for anything unrecognised", () => {
    // A new operation type must not silently cost nothing in the estimate.
    expect(r2Class("SomeOperationCloudflareAddedLater")).toBe("a");
  });
});

describe("gbMonths", () => {
  it("bills a constant month at its full size", () => {
    // Cloudflare: storing 1 GB constantly for 30 days = 1 GB-month.
    expect(gbMonths(Array(30).fill(GB))).toBeCloseTo(1, 6);
  });

  it("reproduces Cloudflare's mixed example", () => {
    // 1 GB for 5 days then 3 GB for 25 days = 2.66 GB-month.
    const days = [...Array(5).fill(GB), ...Array(25).fill(3 * GB)];
    expect(gbMonths(days)).toBeCloseTo(2.6667, 3);
  });

  it("accrues only what has happened so far in a partial cycle", () => {
    // Ten days into the cycle at 3 GB is a third of a 3 GB-month.
    expect(gbMonths(Array(10).fill(3 * GB))).toBeCloseTo(1, 6);
  });

  it("is zero with no data", () => {
    expect(gbMonths([])).toBe(0);
  });
});

describe("range", () => {
  it("counts at least one day so storage maths never divides by zero", () => {
    const now = new Date("2026-09-19T00:00:30Z");
    expect(range(new Date("2026-09-19T00:00:00Z"), now).days).toBe(1);
  });

  it("formats dates the way the analytics filters expect", () => {
    const r = range(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-19T10:30:00Z"));
    expect(r.sinceDate).toBe("2026-09-01");
    expect(r.untilDate).toBe("2026-09-19");
    expect(r.days).toBe(19);
  });
});
