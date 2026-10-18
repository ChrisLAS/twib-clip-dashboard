import { batchSizeIssue } from "./inventory-batch";
import { InventoryCutStatus } from "./inventory-cut-status";
import { useRef, useState } from "react";
import type {
  InventoryReadItem,
  InventoryReview,
  InventoryReviewStatus,
} from "@twib/shared";
import { api } from "./api";

export interface InventoryReviewDraft {
  operationId?: string;
  operationPayload?: string;
  cutMode?: "none" | "range" | "editorial";
  cutStart?: string;
  cutEnd?: string;
  cutGuidance?: string;
  notes: string;
  reason: string;
  status?: InventoryReviewStatus;
  revision: number;
  version: string;
}
export const reviewLabels: Record<InventoryReviewStatus, string> = {
  unreviewed: "Unreviewed",
  approved: "Approved",
  rejected: "Rejected",
  cut_down: "Cut down requested",
};
export function InventoryReviewEditor({
  record,
  episodeNumber,
  cutRequestsEnabled = false,
  csrfToken,
  draft,
  onDraft,
  onSaved,
  onRefresh,
  onFindDerivative,
}: {
  record: InventoryReadItem;
  episodeNumber: number;
  cutRequestsEnabled?: boolean;
  csrfToken?: string;
  draft?: InventoryReviewDraft;
  onDraft: (draft: InventoryReviewDraft | null) => void;
  onSaved: (review: InventoryReview) => void;
  onRefresh: () => void;
  onFindDerivative?: (ref: string) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operation = useRef<{ payload: string; id: string } | null>(null);
  const saved = record.review;
  const value = draft ?? {
    notes: saved?.notes ?? "",
    reason: saved?.reason ?? "",
    revision: saved?.revision ?? 0,
    version: saved?.version ?? "",
  };
  const movedWhileDraft =
    !!draft &&
    !!saved &&
    (draft.version !== saved?.version || draft.revision !== saved?.revision);
  const selectedStatus =
    draft?.status ?? saved?.effectiveStatus ?? "unreviewed";
  function choose(status: InventoryReviewStatus) {
    onDraft({ ...value, status });
    void save(status);
  }
  function change(field: "notes" | "reason", text: string) {
    onDraft({ ...value, [field]: text });
  }
  async function save(status?: InventoryReviewStatus) {
    if (!csrfToken || !saved) return;
    const duration = record.variants[0]?.item.media?.duration_seconds;
    if (
      status &&
      (status === "rejected" ||
        status === "cut_down" ||
        (status === "approved" && (duration == null || duration > 180))) &&
      !value.reason.trim()
    ) {
      setError("Add a decision reason before saving this decision.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const cutSpec =
        status === "cut_down" &&
        cutRequestsEnabled &&
        value.cutMode &&
        value.cutMode !== "none"
          ? value.cutMode === "range"
            ? {
                kind: "range" as const,
                startSeconds: Number(value.cutStart),
                endSeconds: Number(value.cutEnd),
              }
            : {
                kind: "editorial" as const,
                guidance: value.cutGuidance ?? "",
                ...(value.cutStart?.trim()
                  ? { startSeconds: Number(value.cutStart) }
                  : {}),
              }
          : undefined;
      if (
        cutSpec?.kind === "range" &&
        (!value.cutStart?.trim() ||
          !value.cutEnd?.trim() ||
          !Number.isFinite(cutSpec.startSeconds) ||
          !Number.isFinite(cutSpec.endSeconds) ||
          cutSpec.endSeconds <= cutSpec.startSeconds ||
          cutSpec.endSeconds - cutSpec.startSeconds > 180)
      ) {
        setError(
          "Enter start and end seconds for a positive range of at most 180 seconds.",
        );
        return;
      }
      if (cutSpec?.kind === "editorial" && !cutSpec.guidance.trim()) {
        setError("Enter the editorial guidance to save this request.");
        return;
      }
      const payload = {
        episodeNumber,
        itemId: record.id,
        expectedRevision: value.revision,
        expectedVersion: value.version,
        action: status ? ("decision" as const) : ("note" as const),
        notes: value.notes,
        ...(status ? { status, reason: value.reason } : {}),
        ...(cutSpec ? { cutSpec } : {}),
      };
      const fingerprint = JSON.stringify(payload);
      if (operation.current?.payload !== fingerprint)
        operation.current = {
          payload: fingerprint,
          id:
            value.operationPayload === fingerprint && value.operationId
              ? value.operationId
              : crypto.randomUUID(),
        };
      onDraft({
        ...value,
        ...(status ? { status } : {}),
        operationId: operation.current.id,
        operationPayload: fingerprint,
      });
      const response = await api.inventoryReview(
        { ...payload, operationId: operation.current.id },
        csrfToken,
      );
      operation.current = null;
      onDraft(null);
      onSaved(response);
    } catch {
      setError(
        "Saving could not be confirmed. Your draft is retained. Refresh the record and compare the saved review before retrying.",
      );
    } finally {
      setBusy(false);
    }
  }
  const disabled =
    busy ||
    !csrfToken ||
    !saved ||
    record.identityConflict === true ||
    movedWhileDraft;
  return (
    <section
      className="inventory-review-editor"
      aria-label="Persistent clip review"
    >
      <h3>
        Review and notes{" "}
        <span
          className={`inventory-review-badge review-${saved?.effectiveStatus ?? "unreviewed"}`}
        >
          {reviewLabels[saved?.effectiveStatus ?? "unreviewed"]}
        </span>
      </h3>
      {saved?.changed && (
        <p className="inventory-warning">
          The observed media version changed. Notes are retained; the previous
          decision needs review.
        </p>
      )}
      {record.identityConflict && (
        <p className="inventory-warning">
          More than one current file claims this producer identity. Review
          changes are blocked until it is reconciled.
        </p>
      )}
      <label>
        Clip notes
        <textarea
          disabled={busy}
          value={value.notes}
          maxLength={4000}
          onChange={(e) => change("notes", e.target.value)}
          placeholder="Notes saved to your private dashboard"
        />
      </label>
      <div className="inventory-review-actions">
        <button
          type="button"
          disabled={disabled || draft?.status !== undefined}
          onClick={() => void save()}
        >
          Save note
        </button>
        {draft && <span>Unsaved draft</span>}
      </div>
      <label>
        Decision reason
        <textarea
          disabled={busy}
          value={value.reason}
          maxLength={2000}
          onChange={(e) => change("reason", e.target.value)}
          placeholder="Why reject, cut down, or approve an unusually strong long clip?"
        />
      </label>
      {batchSizeIssue(record) && <p role="status">{batchSizeIssue(record)}</p>}
      {cutRequestsEnabled && (
        <fieldset disabled={busy}>
          <legend>Cut instructions</legend>
          <label>
            Request type
            <select
              value={value.cutMode ?? "none"}
              onChange={(e) =>
                onDraft({
                  ...value,
                  cutMode: e.target.value as "none" | "range" | "editorial",
                })
              }
            >
              <option value="none">Decision only</option>
              <option value="range">Explicit range</option>
              <option value="editorial">Editorial guidance</option>
            </select>
          </label>
          {value.cutMode && value.cutMode !== "none" && (
            <label>
              Start seconds
              <input
                type="number"
                min="0"
                step="0.001"
                value={value.cutStart ?? ""}
                onChange={(e) =>
                  onDraft({ ...value, cutStart: e.target.value })
                }
              />
            </label>
          )}
          {value.cutMode === "range" && (
            <label>
              End seconds
              <input
                type="number"
                min="0"
                step="0.001"
                value={value.cutEnd ?? ""}
                onChange={(e) => onDraft({ ...value, cutEnd: e.target.value })}
              />
            </label>
          )}
          {value.cutMode === "editorial" && (
            <label>
              Editorial guidance
              <textarea
                maxLength={2000}
                value={value.cutGuidance ?? ""}
                onChange={(e) =>
                  onDraft({ ...value, cutGuidance: e.target.value })
                }
              />
            </label>
          )}
          <p>
            Save with Cut down. Preserve complete thoughts and qualifications.
            Editorial requests need review before execution.
          </p>
        </fieldset>
      )}
      {[
        ...new Map(
          [
            ...(record.cutRequests ?? []),
            ...(saved?.cutRequest ? [saved.cutRequest] : []),
          ].map((cut) => [cut.requestId, cut]),
        ).values(),
      ].map((cut) => (
        <InventoryCutStatus
          key={cut.requestId}
          cut={cut}
          onFindDerivative={onFindDerivative}
        />
      ))}
      {saved?.cutQueueError && (
        <p role="status">
          Instructions saved; execution was not queued: {saved.cutQueueError}
        </p>
      )}
      <p className="muted">
        Finished clips should usually be three minutes or less. Explain approval
        when duration is longer or unknown. A saved decision applies to this
        observed version.
      </p>
      <p className="inventory-review-choice-state" role="status">
        {busy
          ? `Saving ${reviewLabels[selectedStatus]}…`
          : draft?.status
            ? `Unsaved choice: ${reviewLabels[selectedStatus]}. Saved decision: ${reviewLabels[saved?.effectiveStatus ?? "unreviewed"]}.`
            : `Saved decision: ${reviewLabels[selectedStatus]}.`}
      </p>
      <div
        className="inventory-review-actions"
        role="group"
        aria-label="Review decision choices"
      >
        <button
          type="button"
          className="review-decision-button review-approved"
          aria-pressed={selectedStatus === "approved"}
          disabled={disabled}
          onClick={() => choose("approved")}
        >
          Approve
        </button>
        <button
          type="button"
          className="review-decision-button review-rejected"
          aria-pressed={selectedStatus === "rejected"}
          disabled={disabled}
          onClick={() => choose("rejected")}
        >
          Reject
        </button>
        <button
          type="button"
          className="review-decision-button review-cut_down"
          aria-pressed={selectedStatus === "cut_down"}
          disabled={disabled}
          onClick={() => choose("cut_down")}
        >
          Cut down
        </button>
        <button
          type="button"
          className="review-decision-button review-unreviewed"
          aria-pressed={selectedStatus === "unreviewed"}
          disabled={disabled}
          onClick={() => choose("unreviewed")}
        >
          Mark unreviewed
        </button>
      </div>
      {draft?.status && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => void save(draft.status)}
        >
          Save decision
        </button>
      )}
      {(saved?.effectiveStatus === "rejected" ||
        saved?.effectiveStatus === "cut_down") &&
        !saved?.cutRequest &&
        !record.cutRequests?.length && (
          <p className="muted">
            Decision saved only. No file has been moved or cut by this decision;
            it has no structured cut request and does not start a new job.
          </p>
        )}
      {saved?.savedAt && (
        <p className="muted">
          Saved {new Date(saved.savedAt).toLocaleString()} · revision{" "}
          {saved.revision}
        </p>
      )}
      {error && (
        <p role="alert" className="inventory-warning">
          {error}
        </p>
      )}
      {(error || movedWhileDraft) && (
        <div className="inventory-review-conflict">
          <p>The latest saved note: {saved?.notes || "(empty)"}</p>
          <button type="button" className="quiet" onClick={onRefresh}>
            Refresh record
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              onDraft(null);
              setError("");
            }}
          >
            Reload saved review
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              if (saved) {
                onDraft({
                  ...value,
                  revision: saved.revision,
                  version: saved.version,
                });
                setError("");
              }
            }}
          >
            Keep my draft against latest
          </button>
        </div>
      )}
      {!csrfToken && (
        <p className="muted">An owner session is required to save reviews.</p>
      )}
      <p className="muted">
        Saved notes and decisions persist after reload. Local media stays on
        your workstation.
      </p>
    </section>
  );
}
