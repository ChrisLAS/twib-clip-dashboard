import { describe, it, expect } from "vitest";
import type { InventoryReadItem } from "@twib/shared";
import { batchEligible, batchPayload, parseCutTime } from "./inventory-batch";
const record = {
  id: "item_" + "a".repeat(64),
  identityConflict: false,
  conflictingLatestObservations: false,
  variantsTruncated: false,
  review: { revision: 2, version: "b".repeat(64), notes: "Keep my note" },
  variants: [{ item: { media: { present: true, duration_seconds: 600 } } }],
} as InventoryReadItem;
describe("batch cutdown preparation", () => {
  it("uses first-pass mode without requiring instructions or inventing episode context", () => {
    const result = batchPayload(
      record,
      "",
      { guidance: "", start: "", end: "" },
      "operation",
    );
    expect(result.cutSpec).toEqual({ kind: "first_pass" });
    expect(result.notes).toBe("Keep my note");
    expect(result.expectedRevision).toBe(2);
    expect(result.expectedVersion).toBe(record.review?.version);
    expect(result.operationId).toBe("operation");
  });
  it("combines optional batch and specific guidance and preserves a start hint", () => {
    const result = batchPayload(
      record,
      "Focus on rates",
      { guidance: "Keep the caveat", start: "1:02.500", end: "" },
      "operation",
    );
    expect(result.cutSpec).toEqual({
      kind: "first_pass",
      guidance: "Focus on rates\n\nClip-specific guidance: Keep the caveat",
      startSeconds: 62.5,
    });
  });
  it("accepts bounded explicit timecodes and rejects incomplete, inverted or too-long ranges", () => {
    expect(
      batchPayload(
        record,
        "",
        { guidance: "", start: "2:00", end: "4:00" },
        "operation",
      ).cutSpec,
    ).toEqual({ kind: "range", startSeconds: 120, endSeconds: 240 });
    for (const [start, end] of [
      ["", "30"],
      ["50", "20"],
      ["0", "181"],
      ["590", "601"],
      ["600", ""],
    ]) {
      expect(() =>
        batchPayload(record, "", { guidance: "", start, end }, "op"),
      ).toThrow();
    }
    for (const time of ["-1", "1:99", "abc", "NaN", "1.0001", "24:00:01"])
      expect(() => parseCutTime(time)).toThrow();
    expect(parseCutTime("1:02:03.456")).toBe(3723.456);
  });
  it("excludes exact five-minute, unknown, ambiguous and absent sources", () => {
    expect(batchEligible(record)).toBe(true);
    expect(batchEligible({ ...record, identityConflict: true })).toBe(false);
    expect(
      batchEligible({ ...record, conflictingLatestObservations: true }),
    ).toBe(false);
    for (const duration_seconds of [300, null, 0]) {
      const changed = structuredClone(record);
      changed.variants[0].item.media!.duration_seconds = duration_seconds;
      expect(batchEligible(changed)).toBe(false);
    }
  });
  it("bounds combined guidance before any request is submitted", () => {
    expect(() =>
      batchPayload(
        record,
        "a".repeat(1500),
        { guidance: "b".repeat(1500), start: "", end: "" },
        "operation",
      ),
    ).toThrow("2,000");
  });
});
