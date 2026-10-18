import { useState } from "react";
import "./intake-range.css";
import type { IntakeRangeInput, IntakeWorkView } from "@twib/shared";
import {
  parseRange,
  parseRangeDraft,
  rangeBindingKey,
  rangeDraftKey,
  type RangeDraft,
} from "./intake-range";
export function IntakeRangeForm({
  owner,
  job,
  disabled,
  onSubmit,
}: {
  owner: string;
  job: IntakeWorkView;
  disabled: boolean;
  onSubmit: (input: IntakeRangeInput) => void;
}) {
  const [initial] = useState(() => {
    const draft: RangeDraft = {
      version: 1,
      owner,
      jobId: job.jobId,
      binding: job.rangeSelection!,
      start: "",
      end: "",
    };
    try {
      const raw = sessionStorage.getItem(rangeDraftKey(owner, job.jobId));
      return {
        draft: raw ? parseRangeDraft(raw, owner, job.jobId) : draft,
        raw,
        error: "",
      };
    } catch {
      return {
        draft,
        raw: null,
        error:
          "Local range drafts are unavailable or invalid. No range can be sent.",
      };
    }
  });
  const [draft, setDraft] = useState(initial.draft);
  const [stored, setStored] = useState(initial.raw);
  const [error, setError] = useState(initial.error);
  const binding = job.rangeSelection!;
  const mismatch = rangeBindingKey(draft.binding) !== rangeBindingKey(binding);
  const range = parseRange(draft.start, draft.end);
  function save(next: RangeDraft) {
    setDraft(next);
    try {
      const key = rangeDraftKey(owner, job.jobId);
      if (sessionStorage.getItem(key) !== stored)
        throw new Error(
          "This tab’s saved draft changed. Reload to review its saved values.",
        );
      const wire = JSON.stringify(next);
      sessionStorage.setItem(key, wire);
      if (sessionStorage.getItem(key) !== wire)
        throw new Error("Range draft could not be saved. No range was sent.");
      setStored(wire);
      setError("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Range draft could not be saved.",
      );
    }
  }
  return (
    <fieldset disabled={disabled} className="intake-range-form">
      <legend>Choose a range from the captured original</legend>
      <p>
        Enter source-relative seconds after listening or reviewing the
        transcript. Maximum 180 seconds. The original and its notes stay
        unchanged.
      </p>
      <p className="muted">
        Source: {job.cutRequest?.parent.ref ?? "Captured original"}
      </p>
      <label>
        Start seconds{" "}
        <input
          type="text"
          inputMode="decimal"
          maxLength={32}
          value={draft.start}
          disabled={mismatch || !!error}
          onChange={(e) => save({ ...draft, start: e.target.value })}
        />
      </label>
      <label>
        End seconds{" "}
        <input
          type="text"
          inputMode="decimal"
          maxLength={32}
          value={draft.end}
          disabled={mismatch || !!error}
          onChange={(e) => save({ ...draft, end: e.target.value })}
        />
      </label>
      {mismatch && (
        <p role="alert">
          The captured source or request changed. Your old draft is preserved
          and cannot be submitted against the new binding.
        </p>
      )}
      {mismatch && (
        <button
          type="button"
          onClick={() => save({ ...draft, binding, start: "", end: "" })}
        >
          Discard old range draft and use current source
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {!job.rangeDispatchEnabled && (
        <p role="status">
          Cut dispatch is disabled or its exact-episode grant is not current.
          Refresh work status after it is enabled; your draft is saved.
        </p>
      )}
      {!range && (draft.start || draft.end) && (
        <p>
          Use non-negative decimal seconds, with an end after the start and a
          duration of at most 180 seconds.
        </p>
      )}
      <button
        type="button"
        disabled={
          disabled ||
          !!error ||
          mismatch ||
          !range ||
          job.rangeDispatchEnabled !== true ||
          job.stale
        }
        onClick={() => {
          if (range && !mismatch && !error && job.rangeDispatchEnabled)
            onSubmit({ ...draft.binding, range });
        }}
      >
        Save range and queue cut
      </button>
      <p className="muted">
        This queues one cut. It does not approve the original or the result.
      </p>
    </fieldset>
  );
}
