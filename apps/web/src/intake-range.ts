import type { IntakeRangeInput, IntakeWorkView } from "@twib/shared";
export type RangeBinding = NonNullable<IntakeWorkView["rangeSelection"]>;
export type RangeDraft = {
  version: 1;
  owner: string;
  jobId: string;
  binding: RangeBinding;
  start: string;
  end: string;
};
export const rangeDraftKey = (owner: string, jobId: string) =>
  `twib:intake-range:v1:${encodeURIComponent(owner)}:${encodeURIComponent(jobId)}`;
export function rangeBindingKey(binding: RangeBinding) {
  return JSON.stringify([
    binding.expectedCutRequestId,
    binding.expectedRequestRevision,
    binding.expectedParentVersion,
    binding.expectedRevision,
    binding.expectedWorkspaceRevision,
    binding.episodeNumber,
  ]);
}
export function validRangeBinding(value: unknown): value is RangeBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as RangeBinding;
  return (
    /^[0-9a-f-]{36}$/.test(v.expectedCutRequestId) &&
    /^[0-9a-f]{64}$/.test(v.expectedRequestRevision) &&
    /^[0-9a-f]{64}$/.test(v.expectedParentVersion) &&
    [v.expectedRevision, v.expectedWorkspaceRevision, v.episodeNumber].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) &&
    v.episodeNumber <= 999999 &&
    Object.keys(v).sort().join(",") ===
      "episodeNumber,expectedCutRequestId,expectedParentVersion,expectedRequestRevision,expectedRevision,expectedWorkspaceRevision"
  );
}
export function parseRange(
  start: string,
  end: string,
): IntakeRangeInput["range"] | null {
  // Decimal source seconds only; reject blanks, exponents and fractional milliseconds.
  if (![start, end].every((v) => /^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(v)))
    return null;
  const a = Number(start),
    b = Number(end);
  return Number.isFinite(a) &&
    Number.isFinite(b) &&
    a >= 0 &&
    b > a &&
    b <= 86400 &&
    b - a <= 180
    ? { kind: "range", startSeconds: a, endSeconds: b }
    : null;
}
export function validRangeInput(value: unknown): value is IntakeRangeInput {
  if (!value || typeof value !== "object") return false;
  const { range, ...binding } = value as IntakeRangeInput;
  if (
    !validRangeBinding(binding) ||
    !range ||
    range.kind !== "range" ||
    Object.keys(range).sort().join(",") !== "endSeconds,kind,startSeconds"
  )
    return false;
  const parsed = parseRange(
    String(range.startSeconds),
    String(range.endSeconds),
  );
  return (
    !!parsed &&
    typeof range.startSeconds === "number" &&
    typeof range.endSeconds === "number"
  );
}
export function parseRangeDraft(
  raw: string,
  owner: string,
  jobId: string,
): RangeDraft {
  const v = JSON.parse(raw) as RangeDraft;
  if (
    !owner ||
    v.version !== 1 ||
    v.owner !== owner ||
    v.jobId !== jobId ||
    !validRangeBinding(v.binding) ||
    typeof v.start !== "string" ||
    typeof v.end !== "string" ||
    v.start.length > 32 ||
    v.end.length > 32
  )
    throw new Error(
      "Saved range draft could not be verified. No range was sent.",
    );
  return v;
}
export function rangeAttemptConfirmed(
  input: IntakeRangeInput,
  job: IntakeWorkView,
) {
  const cut = job.cutRequest;
  return (
    !!job.rangeSelection &&
    rangeBindingKey(job.rangeSelection) === rangeBindingKey(input) &&
    cut?.selectionOrigin === "owner_range" &&
    cut.sourcePlanRequestId === input.expectedCutRequestId &&
    cut.parentVersion === input.expectedParentVersion &&
    cut.spec.kind === "range" &&
    cut.spec.startSeconds === input.range.startSeconds &&
    cut.spec.endSeconds === input.range.endSeconds
  );
}
export function validRangeReceipt(
  value: unknown,
  input: IntakeRangeInput,
): value is {
  requestId: string;
  sourcePlanRequestId: string;
  selectionOrigin: "owner_range";
} {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return (
    typeof receipt.requestId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      receipt.requestId,
    ) &&
    receipt.sourcePlanRequestId === input.expectedCutRequestId &&
    receipt.selectionOrigin === "owner_range" &&
    Object.keys(receipt).sort().join(",") ===
      "requestId,selectionOrigin,sourcePlanRequestId"
  );
}
