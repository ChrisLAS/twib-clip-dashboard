import { useRef, useState } from "react";
import type {
  InventoryReadItem,
  InventoryReview,
  InventoryReviewInput,
} from "@twib/shared";
import { api, RequestError } from "./api";
import {
  batchEligible,
  batchPayload,
  type BatchInstructions,
} from "./inventory-batch";

type Entry = {
  record: InventoryReadItem;
  instructions: BatchInstructions;
  payload?: InventoryReviewInput;
  result?: InventoryReview;
  error?: string;
  rejected?: boolean;
};
export function InventoryBatchPanel({
  items,
  csrfToken,
  blockedIds,
  onSaved,
}: {
  items: InventoryReadItem[];
  csrfToken?: string;
  blockedIds: string[];
  onSaved: (itemId: string, review: InventoryReview) => void;
}) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const locked = Object.values(entries).some((e) => e.payload);
  const selected = Object.values(entries);
  function toggle(record: InventoryReadItem) {
    if (busy || locked) return;
    setEntries((old) => {
      const next = { ...old };
      if (next[record.id]) delete next[record.id];
      else if (Object.keys(next).length < 20)
        next[record.id] = {
          record,
          instructions: { guidance: "", start: "", end: "" },
        };
      return next;
    });
  }
  function edit(id: string, field: keyof BatchInstructions, value: string) {
    setEntries((old) => ({
      ...old,
      [id]: {
        ...old[id],
        instructions: { ...old[id].instructions, [field]: value },
      },
    }));
  }
  async function submit() {
    if (running.current || !csrfToken || !selected.length) return;
    let requests: Entry[];
    try {
      requests = selected.map((entry) => {
        if (entry.payload) return entry;
        const current = items.find((item) => item.id === entry.record.id);
        if (
          blockedIds.includes(entry.record.id) ||
          (current &&
            (current.review?.revision !== entry.record.review?.revision ||
              current.review?.version !== entry.record.review?.version ||
              !batchEligible(current)))
        )
          throw new Error(
            "A selected clip changed or has an unsaved review. Clear this batch, refresh and select it again.",
          );
        return {
          ...entry,
          payload: batchPayload(
            entry.record,
            guidance,
            entry.instructions,
            crypto.randomUUID(),
          ),
        };
      });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Check the selected clips and timecodes.",
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    setEntries(
      Object.fromEntries(requests.map((entry) => [entry.record.id, entry])),
    );
    for (const entry of requests) {
      if (entry.result || entry.rejected || !entry.payload) continue;
      try {
        const result = await api.inventoryReview(entry.payload, csrfToken);
        setEntries((old) => ({
          ...old,
          [entry.record.id]: { ...entry, result, error: undefined },
        }));
        onSaved(entry.record.id, result);
      } catch (e) {
        setEntries((old) => ({
          ...old,
          [entry.record.id]: {
            ...entry,
            rejected:
              e instanceof RequestError && [409, 422].includes(e.status),
            error:
              e instanceof RequestError && [409, 422].includes(e.status)
                ? "Request rejected: " +
                  e.message +
                  " Clear the batch, refresh and select again."
                : "Save not confirmed. Retry uses the same operation ID; successful clips will not be resubmitted.",
          },
        }));
      }
    }
    running.current = false;
    setBusy(false);
  }
  return (
    <section
      className="inventory-batch-panel"
      aria-label="Batch cutdown requests"
    >
      <h2>First-pass cutdowns</h2>
      <p>
        Select up to 20 clips longer than 5 minutes. Selection stays while
        browsing pages. Originals stay intact; new versions require your review.
      </p>
      <p>
        Episode-context planning is not connected yet. First-pass requests are
        saved for planning, not automatically cut. Explicit ranges use the
        existing execution gates.
      </p>
      <fieldset disabled={busy || locked}>
        <legend>Eligible clips on this page</legend>
        {items.filter(batchEligible).map((record) => (
          <label key={record.id} className="inventory-batch-choice">
            <input
              type="checkbox"
              checked={!!entries[record.id]}
              disabled={
                blockedIds.includes(record.id) ||
                (!entries[record.id] && selected.length >= 20)
              }
              onChange={() => toggle(record)}
            />
            {record.filename ?? record.variants[0].item.media?.ref}
            {blockedIds.includes(record.id)
              ? " · finish your unsaved review first"
              : ""}
          </label>
        ))}
        {!items.some(batchEligible) && (
          <p>No eligible long clips on this page.</p>
        )}
        <label>
          Batch guidance (optional)
          <textarea
            aria-label="Batch guidance"
            value={guidance}
            maxLength={1500}
            onChange={(e) => setGuidance(e.target.value)}
            placeholder="Leave blank to request a first pass using the episode narrative."
          />
        </label>
      </fieldset>
      {selected.map((entry) => (
        <section key={entry.record.id} aria-label="Selected cutdown">
          <strong>
            {entry.record.filename ?? entry.record.variants[0].item.media?.ref}
          </strong>
          <fieldset disabled={busy || locked}>
            <legend>Clip-specific instructions (optional)</legend>
            <label>
              Guidance
              <textarea
                aria-label={"Guidance for " + entry.record.id}
                maxLength={1500}
                value={entry.instructions.guidance}
                onChange={(e) =>
                  edit(entry.record.id, "guidance", e.target.value)
                }
              />
            </label>
            <label>
              Start time
              <input
                aria-label={"Start for " + entry.record.id}
                value={entry.instructions.start}
                placeholder="MM:SS or seconds"
                onChange={(e) => edit(entry.record.id, "start", e.target.value)}
              />
            </label>
            <label>
              End time
              <input
                aria-label={"End for " + entry.record.id}
                value={entry.instructions.end}
                placeholder="Optional; range ≤3 minutes"
                onChange={(e) => edit(entry.record.id, "end", e.target.value)}
              />
            </label>
          </fieldset>
          {!!entry.instructions.end.trim() && (
            <p>
              Explicit range selected; narrative guidance does not alter these
              exact boundaries.
            </p>
          )}
          {entry.result && (
            <p role="status">
              Request saved: {entry.result.cutRequest?.state ?? "decision only"}
              {entry.result.cutRequest?.code
                ? " · " + entry.result.cutRequest.code
                : ""}
              {entry.result.cutQueueError
                ? " · " + entry.result.cutQueueError
                : ""}
            </p>
          )}
          {entry.error && <p role="alert">{entry.error}</p>}
        </section>
      ))}
      {error && <p role="alert">{error}</p>}
      <p>
        {selected.length} selected · {selected.filter((e) => e.result).length}{" "}
        saved
      </p>
      <button
        type="button"
        disabled={
          busy ||
          !csrfToken ||
          !selected.length ||
          selected.every((e) => e.result || e.rejected)
        }
        onClick={() => void submit()}
      >
        {busy
          ? "Saving requests…"
          : locked
            ? "Retry unconfirmed requests"
            : "Save cutdown requests"}
      </button>
      <button
        type="button"
        disabled={
          busy ||
          !selected.length ||
          selected.some((e) => e.payload && !e.result && !e.rejected)
        }
        onClick={() => {
          setEntries({});
          setError("");
          setGuidance("");
        }}
      >
        Clear batch
      </button>
      {locked && (
        <p>
          Keep this page open until every save is confirmed. Retries preserve
          the original request and source version.
        </p>
      )}
    </section>
  );
}
