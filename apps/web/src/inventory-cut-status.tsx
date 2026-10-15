import type { InventoryCutRequest } from "@twib/shared";

export function cutStatusLabel(cut: InventoryCutRequest) {
  if (cut.derivative) return "Review version available · Unreviewed";
  if (cut.transitionCode)
    return "Automatic cut blocked: source or review changed";
  if (cut.state === "failed") return "Cutdown failed";
  if (
    cut.state === "blocked" ||
    cut.state === "waiting_for_episode" ||
    cut.code === "CONTEXT_MISSING"
  )
    return cut.code === "CONTEXT_MISSING"
      ? "Blocked: episode context unavailable"
      : "Blocked: action needed";
  if (cut.proposal) return "Cut plan prepared · Unreviewed";
  if (cut.state === "queued")
    return cut.spec.kind === "first_pass"
      ? "Queued for episode-context planning"
      : "Queued for cutdown render";
  if (cut.state === "running")
    return cut.spec.kind === "first_pass"
      ? "Planning cutdown"
      : "Rendering review version";
  if (cut.state === "succeeded")
    return "Job finished; review file not attached";
  if (cut.state === "needs_review") return "Needs review before continuing";
  return "Request saved · " + cut.state;
}
export function InventoryCutStatus({
  cut,
  onFindDerivative,
}: {
  cut: InventoryCutRequest;
  onFindDerivative?: (ref: string) => void;
}) {
  return (
    <section
      className="inventory-cut-status"
      id={"cut-request-" + cut.requestId}
      aria-label="Saved cut request"
    >
      <p>
        <strong>{cutStatusLabel(cut)}</strong>
        {cut.code ? " · " + cut.code : ""}
      </p>
      <p>
        Original: {cut.parent.ref} ·{" "}
        {cut.parent.clip_id ?? cut.parent.clip_uid ?? cut.parentItemId}
      </p>
      <p>
        Request version: {cut.requestId} · Review revision {cut.reviewRevision}
      </p>
      {cut.sourcePlanRequestId && (
        <p>
          From first-pass plan:{" "}
          <a href={"#cut-request-" + cut.sourcePlanRequestId}>
            {cut.sourcePlanRequestId}
          </a>
        </p>
      )}
      <p>
        {cut.spec.kind === "range"
          ? cut.spec.startSeconds + "–" + cut.spec.endSeconds + " seconds"
          : (cut.spec.guidance ??
            "Use the episode narrative for a first pass.")}
      </p>
      {cut.transitionCode && (
        <p role="status">
          {cut.transitionCode}: The plan was saved, but no automatic review cut
          was started. Refresh the source and submit a new current-version
          request.
        </p>
      )}
      {cut.proposal && (
        <div aria-label="Cutdown plan">
          <p>
            Proposed source range: {cut.proposal.range.startSeconds}–
            {cut.proposal.range.endSeconds} seconds
          </p>
          <p>{cut.proposal.rationale}</p>
          <p>Episode context revision: {cut.proposal.contextRevision}</p>
          <p>Transcript revision: {cut.proposal.transcriptRevision}</p>
          <p>
            This plan is not a finished review file. Rendering depends on the
            execution gate and source checks.
          </p>
        </div>
      )}
      {cut.derivative && (
        <div aria-label="Cutdown review version">
          <p>
            Review file: {cut.derivative.ref} ·{" "}
            {cut.derivative.duration_seconds} seconds · Unreviewed
          </p>
          <p>
            Parent: {cut.derivative.parent_clip_id} · Source range{" "}
            {cut.derivative.local_in_seconds}–{cut.derivative.local_out_seconds}{" "}
            seconds
          </p>
          <p>SHA-256: {cut.derivative.sha256}</p>
          {onFindDerivative && (
            <button
              type="button"
              onClick={() => onFindDerivative(cut.derivative!.ref)}
            >
              Find imported review version
            </button>
          )}
          <p>
            The original is retained. Review this new version separately before
            approving it.
          </p>
        </div>
      )}
    </section>
  );
}
