import { useState } from "react";
import type {
  InventoryReadItem,
  InventoryReview,
  InventoryReviewStatus,
} from "@twib/shared";
import { api } from "./api";

export interface InventoryReviewDraft {
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
  csrfToken,
  draft,
  onDraft,
  onSaved,
  onRefresh,
}: {
  record: InventoryReadItem;
  csrfToken?: string;
  draft?: InventoryReviewDraft;
  onDraft: (draft: InventoryReviewDraft | null) => void;
  onSaved: (review: InventoryReview) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
      const response = await api.inventoryReview(
        {
          operationId: crypto.randomUUID(),
          episodeNumber: 127,
          itemId: record.id,
          expectedRevision: value.revision,
          expectedVersion: value.version,
          action: status ? "decision" : "note",
          notes: value.notes,
          ...(status ? { status, reason: value.reason } : {}),
        },
        csrfToken,
      );
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
        saved?.effectiveStatus === "cut_down") && (
        <p className="muted">
          Decision saved only. No file has been moved or cut; Nomad actions are
          not enabled.
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
