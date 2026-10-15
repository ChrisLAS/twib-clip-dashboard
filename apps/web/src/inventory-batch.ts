import type { InventoryReadItem, InventoryReviewInput } from "@twib/shared";

export interface BatchInstructions {
  guidance: string;
  start: string;
  end: string;
}
export function batchSizeIssue(record: InventoryReadItem): string | null {
  return (record.variants[0]?.item.media?.size_bytes ?? 0) > 512 * 1024 * 1024
    ? "Source exceeds the 512 MiB cut-job limit. Choose a smaller source; the original is unchanged."
    : null;
}
export function batchEligible(record: InventoryReadItem) {
  const media = record.variants[0]?.item.media;
  return (
    !batchSizeIssue(record) &&
    !!record.review &&
    !record.identityConflict &&
    !record.conflictingLatestObservations &&
    !record.variantsTruncated &&
    !!media?.present &&
    (media.duration_seconds ?? 0) > 300
  );
}
export function parseCutTime(value: string): number | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d{1,3})?$/.test(value.trim()))
    throw new Error(
      "Use seconds, MM:SS or HH:MM:SS, with up to three decimal places.",
    );
  const n = value
    .trim()
    .split(":")
    .reduce((sum, part) => sum * 60 + Number(part), 0);
  if (n > 86400) throw new Error("Timecodes must be within 24 hours.");
  return n;
}
export function batchPayload(
  record: InventoryReadItem,
  batchGuidance: string,
  instruction: BatchInstructions,
  operationId: string,
): InventoryReviewInput {
  if (batchSizeIssue(record)) throw new Error(batchSizeIssue(record)!);
  if (!batchEligible(record) || !record.review)
    throw new Error(
      "Select an unchanged, uniquely identified clip longer than 5 minutes.",
    );
  const start = parseCutTime(instruction.start),
    end = parseCutTime(instruction.end);
  const guidance = [batchGuidance.trim(), instruction.guidance.trim()]
    .filter(Boolean)
    .join("\n\nClip-specific guidance: ");
  if (guidance.length > 2000)
    throw new Error(
      "Combined batch and clip guidance must be at most 2,000 characters.",
    );
  if (
    end !== undefined &&
    (start === undefined || end <= start || end - start > 180)
  )
    throw new Error(
      "An explicit range needs both times and must be positive and no longer than 180 seconds.",
    );
  if (
    end !== undefined &&
    end > (record.variants[0]?.item.media?.duration_seconds ?? 0)
  )
    throw new Error("The end time exceeds the source duration.");
  if (
    start !== undefined &&
    start >= (record.variants[0]?.item.media?.duration_seconds ?? 0)
  )
    throw new Error("The start time must be within the source.");
  return {
    operationId,
    episodeNumber: 127,
    itemId: record.id,
    expectedRevision: record.review.revision,
    expectedVersion: record.review.version,
    action: "decision",
    status: "cut_down",
    notes: record.review.notes,
    reason: "First-pass cutdown requested for owner review.",
    cutSpec:
      end !== undefined && start !== undefined
        ? { kind: "range", startSeconds: start, endSeconds: end }
        : {
            kind: "first_pass",
            ...(guidance ? { guidance } : {}),
            ...(start !== undefined ? { startSeconds: start } : {}),
          },
  };
}
