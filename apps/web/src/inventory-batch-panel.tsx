import { cutStatusLabel } from "./inventory-cut-status";
import { useEffect, useRef, useState } from "react";
import type {
  InventoryReadItem,
  InventoryReview,
  InventoryReviewInput,
} from "@twib/shared";
import { api, RequestError } from "./api";
import {
  batchEligible,
  batchSizeIssue,
  batchPayload,
  type BatchInstructions,
} from "./inventory-batch";
import {
  clearOutbox,
  newOutbox,
  outboxKey,
  readOutbox,
  writeOutbox,
  type BatchOutbox,
  type BatchScope,
} from "./inventory-batch-outbox";

type Entry = {
  record: InventoryReadItem;
  instructions: BatchInstructions;
  payload?: InventoryReviewInput;
  saved?: boolean;
  receipt?: { state: string; code?: string };
  error?: string;
  rejected?: boolean;
};
function restore(box: BatchOutbox | null): Record<string, Entry> {
  return Object.fromEntries(
    (box?.entries ?? []).map((entry) => {
      const p = entry.payload;
      return [
        p.itemId,
        {
          record: {
            id: p.itemId,
            filename: "Restored request " + p.itemId.slice(-12),
            variants: [],
            readiness: "not_evaluated",
            conflictingLatestObservations: false,
            variantsTruncated: false,
          },
          instructions: {
            guidance:
              p.cutSpec.kind === "first_pass" ? (p.cutSpec.guidance ?? "") : "",
            start: p.cutSpec.startSeconds?.toString() ?? "",
            end:
              p.cutSpec.kind === "range" ? p.cutSpec.endSeconds.toString() : "",
          },
          payload: p,
          saved: entry.status === "saved",
          rejected: entry.status === "rejected",
          receipt: entry.receipt,
          error:
            entry.status === "pending"
              ? "Restored unconfirmed operation. Reconcile using its original operation ID."
              : undefined,
        },
      ];
    }),
  );
}
export function InventoryBatchPanel({
  items,
  csrfToken,
  blockedIds,
  scope,
  onSaved,
  planningEnabled = false,
  executionEnabled = false,
  autoRenderEnabled = false,
  onRefresh,
}: {
  items: InventoryReadItem[];
  planningEnabled?: boolean;
  executionEnabled?: boolean;
  autoRenderEnabled?: boolean;
  onRefresh?: () => void;
  csrfToken?: string;
  blockedIds: string[];
  scope: BatchScope;
  onSaved: (itemId: string, review: InventoryReview) => void;
}) {
  const [initial] = useState(() => {
    try {
      return { entries: restore(readOutbox(localStorage, scope)), error: "" };
    } catch {
      return {
        entries: {},
        error:
          "Stored batch cannot be read safely. Submission is blocked; restore browser storage access and reload. Do not recreate uncertain requests.",
      };
    }
  });
  const [entries, setEntries] = useState<Record<string, Entry>>(
    initial.entries,
  );
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(initial.error);
  const liveBlockedIds = useRef(blockedIds);
  liveBlockedIds.current = blockedIds;
  const running = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const locked = Object.values(entries).some((e) => e.payload);
  const selected = Object.values(entries);
  function toggle(record: InventoryReadItem) {
    if (busy || locked || storageError) return;
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
  async function submitLocked() {
    if (!csrfToken || !mounted.current) return;
    let requests: Entry[];
    let box: BatchOutbox;
    try {
      const existing = readOutbox(localStorage, scope);
      if (existing) {
        const expected = selected
          .filter((e) => e.payload)
          .map((e) => e.payload);
        if (
          JSON.stringify(existing.entries.map((e) => e.payload)) !==
          JSON.stringify(expected)
        ) {
          setEntries(restore(existing));
          setError(
            "Another saved batch was found. Review it and reconcile its original operations.",
          );
          return;
        }
      }
      if (
        selected.some(
          (entry) =>
            !existing &&
            !entry.saved &&
            !entry.rejected &&
            liveBlockedIds.current.includes(entry.record.id),
        )
      )
        throw new Error(
          "A selected clip has an unsaved review. Finish the draft before submitting or reconciling this batch.",
        );
      requests = selected.map((entry) => {
        if (entry.payload) return entry;
        const current = items.find((item) => item.id === entry.record.id);
        if (
          liveBlockedIds.current.includes(entry.record.id) ||
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
      // All immutable operations are durable before the first network request.
      box =
        existing ??
        newOutbox(
          scope,
          requests.map((e) => e.payload!),
        );
      writeOutbox(localStorage, scope, box);
      requests = requests.map((entry, i) => ({
        ...entry,
        saved: box.entries[i].status === "saved",
        rejected: box.entries[i].status === "rejected",
        receipt: box.entries[i].receipt,
      }));
      setEntries(
        Object.fromEntries(requests.map((entry) => [entry.record.id, entry])),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Cannot prepare this batch safely.",
      );
      return;
    }
    for (let i = 0; i < box.entries.length; i++) {
      const operation = box.entries[i];
      if (!mounted.current) break;
      if (operation.status !== "pending") continue;
      if (
        operation.attempted === false &&
        liveBlockedIds.current.includes(operation.payload.itemId)
      ) {
        setError(
          "An unsaved row review blocks this operation. Finish that draft before reconciling the batch.",
        );
        break;
      }
      let result: InventoryReview | undefined;
      let rejected = false;
      let message: string | undefined;
      try {
        // Readback immediately before dispatch prevents sending after storage loss.
        const current = readOutbox(localStorage, scope);
        if (JSON.stringify(current) !== JSON.stringify(box))
          throw new Error("Outbox changed");
        // Durable attempt marker distinguishes safe reconciliation from a first dispatch.
        // No await occurs between the live-draft check, persistence and dispatch.
        operation.attempted = true;
        writeOutbox(localStorage, scope, box);
      } catch {
        setStorageError(
          "Batch storage changed or became unavailable. Submission stopped; restore storage and reload to reconcile.",
        );
        break;
      }
      try {
        result = await api.inventoryReview(operation.payload, csrfToken);
      } catch (e) {
        rejected = e instanceof RequestError && [409, 422].includes(e.status);
        message = rejected
          ? "Request rejected: " +
            (e as Error).message +
            " Clear the batch, refresh and select again."
          : "Save not confirmed. Retry uses the same operation ID; successful clips will not be resubmitted.";
      }
      const receipt = result
        ? {
            state: result.cutRequest?.state ?? "decision only",
            ...(result.cutRequest?.code
              ? { code: result.cutRequest.code }
              : {}),
          }
        : undefined;
      box.entries[i] = {
        ...operation,
        status: result ? "saved" : rejected ? "rejected" : "pending",
        ...(receipt ? { receipt } : {}),
      };
      try {
        writeOutbox(localStorage, scope, box);
      } catch {
        setStorageError(
          "The response could not be stored. Submission stopped. Reload after restoring storage to replay the original operation safely.",
        );
        break;
      }
      if (!mounted.current) break;
      const entry = requests[i];
      setEntries((old) => ({
        ...old,
        [operation.payload.itemId]: {
          ...entry,
          saved: !!result,
          receipt,
          rejected,
          error: message,
        },
      }));
      if (result) onSaved(operation.payload.itemId, result);
    }
  }
  async function submit() {
    if (running.current || !csrfToken || !selected.length || storageError)
      return;
    if (!navigator.locks) {
      setStorageError(
        "Safe browser locking is unavailable; batch submission is blocked.",
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await navigator.locks.request(
        outboxKey(scope),
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            setError(
              "This batch is active in another tab. Wait for it to finish, then reload.",
            );
            return;
          }
          await submitLocked();
        },
      );
    } catch {
      setStorageError(
        "Batch storage or locking failed. Reload to reconcile before submitting anything new.",
      );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function clear() {
    if (storageError || busy || !navigator.locks) return;
    await navigator.locks.request(
      outboxKey(scope),
      { ifAvailable: true },
      (lock) => {
        if (!lock) {
          setError("The batch is active in another tab.");
          return;
        }
        try {
          clearOutbox(localStorage, scope);
          setEntries({});
          setError("");
          setGuidance("");
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not clear stored batch.",
          );
        }
      },
    );
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
        {planningEnabled
          ? "Episode-context planning is enabled. First-pass requests can be queued for planning."
          : "Episode-context planning is disabled. First-pass requests are saved without starting planning."}{" "}
        {executionEnabled
          ? "Explicit-range rendering is enabled for eligible bounded cuts."
          : "Rendering is disabled. No new review file will be produced until execution is enabled."}{" "}
        {autoRenderEnabled
          ? "Automatic first-pass rendering is enabled; finished versions remain unreviewed."
          : "Automatic first-pass rendering is disabled; a prepared plan alone does not start a render."}
      </p>
      <fieldset disabled={busy || locked || !!storageError}>
        <legend>Eligible clips on this page</legend>
        {items
          .filter(
            (record) =>
              (record.variants[0]?.item.media?.duration_seconds ?? 0) > 300,
          )
          .map((record) => (
            <label key={record.id} className="inventory-batch-choice">
              <input
                type="checkbox"
                checked={!!entries[record.id]}
                disabled={
                  !batchEligible(record) ||
                  blockedIds.includes(record.id) ||
                  (!entries[record.id] && selected.length >= 20)
                }
                onChange={() => toggle(record)}
              />
              {record.filename ?? record.variants[0].item.media?.ref}
              {!batchEligible(record)
                ? " · " +
                  (batchSizeIssue(record) ??
                    "Resolve source identity or review before selecting.")
                : ""}
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
      {onRefresh && (
        <button type="button" disabled={busy} onClick={onRefresh}>
          Refresh request status
        </button>
      )}
      {selected.map((entry) => (
        <section key={entry.record.id} aria-label="Selected cutdown">
          <strong>
            {entry.record.filename ?? entry.record.variants[0].item.media?.ref}
          </strong>
          <fieldset disabled={busy || locked || !!storageError}>
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
          {entry.saved && (
            <p role="status">
              Request saved: {entry.receipt?.state ?? "decision only"}
              {entry.receipt?.code ? " · " + entry.receipt.code : ""}
            </p>
          )}
          {items
            .find((item) => item.id === entry.record.id)
            ?.cutRequests?.map((cut) => (
              <p key={cut.requestId}>
                Latest request status: {cutStatusLabel(cut)}
                {cut.code ? " · " + cut.code : ""}
                {cut.derivative ? " · " + cut.derivative.ref : ""}
              </p>
            ))}
          {entry.saved && (
            <p>
              Saved acknowledgement above; refresh and open the source row for
              current plans and review versions.
            </p>
          )}
          {entry.error && <p role="alert">{entry.error}</p>}
        </section>
      ))}
      {storageError && <p role="alert">{storageError}</p>}
      {error && <p role="alert">{error}</p>}
      <p>
        {selected.length} selected · {selected.filter((e) => e.saved).length}{" "}
        saved
      </p>
      <button
        type="button"
        disabled={
          busy ||
          !csrfToken ||
          !!storageError ||
          !selected.length ||
          selected.every((e) => e.saved || e.rejected)
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
          !!storageError ||
          !selected.length ||
          selected.some((e) => e.payload && !e.saved && !e.rejected)
        }
        onClick={() => void clear()}
      >
        Clear batch
      </button>
      {locked && (
        <p>
          Pending operations are saved in this browser. After a reload,
          reconcile this batch before starting another; retries preserve the
          original request and source version.
        </p>
      )}
    </section>
  );
}
