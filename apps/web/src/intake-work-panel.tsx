import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  IntakeWorkList,
  IntakeRangeInput,
  IntakeWorkPriority,
  IntakeWorkView,
  ManualIntake,
} from "@twib/shared";
import { api, RequestError } from "./api";
import { readIntakeDraft } from "./intake-drafts";
import { intakeTime } from "./intake-state";
import { IntakeRangeForm } from "./intake-range-form";
import {
  validRangeInput,
  validRangeReceipt,
  rangeAttemptConfirmed,
} from "./intake-range";

export type WorkAttempt =
  | { kind: "range"; intakeId: string; jobId: string; input: IntakeRangeInput }
  | {
      kind: "save";
      intakeId: string;
      expectedRevision: number;
      priority: IntakeWorkPriority;
    }
  | {
      kind: "retry";
      intakeId: string;
      jobId: string;
      expectedAttempt: number;
      expectedTargetId: string;
    };
export const workOutboxKey = (owner: string) =>
  `twib:intake-work:v2:${encodeURIComponent(owner)}`;
export function parseWorkEnvelope(raw: string, owner: string): WorkAttempt {
  const value = JSON.parse(raw);
  if (
    !owner ||
    value?.version !== 2 ||
    value?.owner !== owner ||
    value?.scope !== "manual-intake-work"
  )
    throw new Error("Work confirmation ownership could not be verified.");
  const attempt = parseWorkAttempt(JSON.stringify(value.attempt));
  if (!attempt) throw new Error("Work confirmation data is invalid.");
  return attempt;
}
function readOwnerAttempt(owner: string): {
  attempt: WorkAttempt | null;
  error: string;
} {
  try {
    if (!owner) throw new Error("Sign in before saving work requests.");
    if (sessionStorage.getItem("twib:intake-work:v1") !== null)
      throw new Error(
        "An older work confirmation has no verified owner. Work requests are blocked.",
      );
    const raw = localStorage.getItem(workOutboxKey(owner));
    return {
      attempt: raw === null ? null : parseWorkEnvelope(raw, owner),
      error: "",
    };
  } catch {
    return {
      attempt: null,
      error:
        "Local work confirmation storage is unavailable or cannot be verified for this account. Work requests are blocked.",
    };
  }
}
export async function updateWorkOutbox(
  owner: string,
  attempt: WorkAttempt,
  action: "reserve" | "clear",
): Promise<boolean> {
  if (!owner || !navigator.locks?.request)
    throw new Error(
      "Safe work confirmation locking is unavailable. Work requests are blocked.",
    );
  return navigator.locks.request(
    workOutboxKey(owner),
    { mode: "exclusive" },
    () => {
      const stored = readOwnerAttempt(owner);
      if (stored.error) throw new Error(stored.error);
      const envelope = JSON.stringify({
        version: 2,
        scope: "manual-intake-work",
        owner,
        attempt,
      });
      const key = workOutboxKey(owner);
      const raw = localStorage.getItem(key);
      // Compare the complete immutable envelope, never just the owner or root job.
      if (raw !== null && raw !== envelope) return false;
      if (action === "clear") {
        if (raw === envelope) localStorage.removeItem(key);
        if (localStorage.getItem(key) !== null)
          throw new Error("Work confirmation could not be cleared.");
      } else {
        localStorage.setItem(key, envelope);
        if (localStorage.getItem(key) !== envelope)
          throw new Error("Work confirmation could not be verified.");
      }
      return true;
    },
  );
}
export function parseWorkAttempt(raw: string | null): WorkAttempt | null {
  try {
    const value = JSON.parse(raw ?? "null") as WorkAttempt | null;
    if (!value || typeof value.intakeId !== "string" || !value.intakeId)
      return null;
    if (
      value.kind === "save" &&
      Number.isInteger(value.expectedRevision) &&
      value.expectedRevision > 0 &&
      ["normal", "urgent"].includes(value.priority)
    )
      return value;
    if (
      value.kind === "range" &&
      typeof value.jobId === "string" &&
      value.jobId &&
      validRangeInput(value.input)
    )
      return value;
    if (
      value.kind === "retry" &&
      typeof value.jobId === "string" &&
      value.jobId &&
      typeof value.expectedTargetId === "string" &&
      value.expectedTargetId &&
      Number.isInteger(value.expectedAttempt) &&
      value.expectedAttempt >= 0
    )
      return value;
  } catch {
    /* An invalid record cannot authorize a request. */
  }
  return null;
}
export function workAttemptConfirmed(
  attempt: WorkAttempt,
  jobs: IntakeWorkView[],
) {
  return jobs.some(
    (job) =>
      job.intakeId === attempt.intakeId &&
      (attempt.kind === "range"
        ? job.jobId === attempt.jobId &&
          rangeAttemptConfirmed(attempt.input, job)
        : attempt.kind === "save"
          ? job.intakeRevision === attempt.expectedRevision &&
            job.priority === attempt.priority
          : job.jobId === attempt.jobId &&
            (job.retryTargetId ?? job.jobId) === attempt.expectedTargetId &&
            (job.attempt > attempt.expectedAttempt ||
              (job.attempt === attempt.expectedAttempt &&
                ["queued", "running"].includes(job.state)))),
  );
}
export function intakeWorkLabel(
  job: Pick<IntakeWorkView, "stage" | "state">,
): string {
  const labels: Record<string, string> = {
    saved: "Saved",
    queued: "Queued",
    downloading: "Downloading",
    transcribing: "Transcribing",
    awaiting_inventory: "Awaiting inventory",
    planning: "Planning",
    cutting: "Cutting",
    needs_direction: "Needs direction",
    ready_for_review: "Ready for review · unreviewed derivative",
    blocked: "Blocked",
    error: "Error",
  };
  return labels[job.stage] ?? labels[job.state] ?? "Status unavailable";
}
function hasDraftChanges(item: ManualIntake) {
  const draft = readIntakeDraft(item.id);
  return (
    !!draft &&
    (draft.baselineRevision !== item.revision ||
      draft.fields.episodeId !== (item.episodeId ?? "") ||
      draft.fields.start !== intakeTime(item.inMs) ||
      draft.fields.end !== intakeTime(item.outMs) ||
      draft.fields.why !== item.whyItMatters)
  );
}

interface IntakeWorkPanelProps {
  owner: string;
  items: ManualIntake[];
  csrf: string;
  demo: boolean;
  disabled: boolean;
  hidden: boolean;
  onBusy: (busy: boolean) => void;
}
export function IntakeWorkPanel(props: IntakeWorkPanelProps) {
  // Remount isolates in-memory intent and status when the authenticated owner changes.
  return <OwnerIntakeWorkPanel key={props.owner} {...props} />;
}
function OwnerIntakeWorkPanel({
  owner,
  items,
  csrf,
  demo,
  disabled,
  hidden,
  onBusy,
}: IntakeWorkPanelProps) {
  const initial = useRef(readOwnerAttempt(owner));
  const [storageError, setStorageError] = useState(initial.current.error);
  const [status, setStatus] = useState<IntakeWorkList | null>(null);
  const [pending, setPending] = useState<WorkAttempt | null>(
    initial.current.attempt,
  );
  const [priority, setPriority] = useState<Record<string, IntakeWorkPriority>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const pendingRef = useRef(pending);
  const live = useRef({ mounted: true, owner });
  useLayoutEffect(() => {
    live.current = { mounted: true, owner };
    return () => {
      live.current.mounted = false;
    };
  }, [owner]);
  async function clearPending(attempt: WorkAttempt) {
    try {
      if (!(await updateWorkOutbox(owner, attempt, "clear"))) {
        setStorageError(
          "Another work confirmation is pending for this account. Its record was preserved. Reload before continuing.",
        );
        return;
      }
      pendingRef.current = null;
      setPending(null);
    } catch {
      setStorageError(
        "Local confirmation could not be safely cleared. Work requests are blocked.",
      );
    }
  }
  async function refresh(signal?: AbortSignal) {
    try {
      const latest = await api.intakeWork(signal);
      if (signal?.aborted) return;
      setStatus(latest);
      if (
        pendingRef.current &&
        workAttemptConfirmed(pendingRef.current, latest.jobs)
      )
        await clearPending(pendingRef.current);
      setMessage("");
    } catch (error) {
      if (!signal?.aborted)
        setMessage(
          error instanceof Error
            ? error.message
            : "Work status could not be loaded.",
        );
    }
  }
  useEffect(() => {
    if (demo || hidden) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
    // Fetch on visibility changes, never submit as a side effect.
  }, [demo, hidden]);
  async function send(attempt: WorkAttempt) {
    if (lock.current || disabled || demo || !status?.enabled || storageError)
      return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    try {
      // Reserve under the same cross-tab lock used for compare-and-remove.
      try {
        if (!(await updateWorkOutbox(owner, attempt, "reserve"))) {
          setStorageError(
            "Another work confirmation is pending for this account. Reload before continuing.",
          );
          return;
        }
      } catch {
        setStorageError(
          "The work confirmation could not be stored safely. No request was sent.",
        );
        return;
      }
      // The owner may have changed while the cross-tab reservation awaited its lock.
      // Keep the old owner's durable intent, but never dispatch from an unmounted owner.
      if (!live.current.mounted || live.current.owner !== owner) return;
      pendingRef.current = attempt;
      setPending(attempt);
      if (attempt.kind === "range") {
        const receipt = await api.selectIntakeRange(
          attempt.intakeId,
          attempt.jobId,
          attempt.input,
          csrf,
        );
        if (!validRangeReceipt(receipt, attempt.input))
          throw new Error("Range receipt could not be verified.");
        await clearPending(attempt);
        await refresh();
        setMessage(
          "Range selection confirmed. Refresh work status for the latest cut progress. The original and result remain unapproved.",
        );
        return;
      }
      const job =
        attempt.kind === "save"
          ? await api.saveIntakeWork(
              attempt.intakeId,
              {
                expectedRevision: attempt.expectedRevision,
                priority: attempt.priority,
              },
              csrf,
            )
          : await api.retryIntakeWork(
              attempt.intakeId,
              attempt.jobId,
              {
                expectedAttempt: attempt.expectedAttempt,
                expectedTargetId: attempt.expectedTargetId,
              },
              csrf,
            );
      setStatus(
        (previous) =>
          previous && {
            ...previous,
            jobs: [
              ...previous.jobs.filter(
                (existing) => existing.jobId !== job.jobId,
              ),
              job,
            ],
          },
      );
      await clearPending(attempt);
      setMessage(
        "Work request saved. Check the status below for processing progress.",
      );
    } catch (error) {
      if (attempt.kind === "range") {
        // Rejection after an earlier uncertain POST cannot disprove its commit.
        // Only exact readback or explicit owner discard may clear this intent.
        await refresh();
        if (pendingRef.current)
          setMessage(
            "Range confirmation is unresolved. The saved request is retained. Refresh status or retry the same confirmation; discarding it does not cancel any server work.",
          );
      } else if (error instanceof RequestError && error.status < 500) {
        await clearPending(attempt);
        setStatus(null);
        setMessage(error.message + " Refresh work status before trying again.");
      } else
        setMessage(
          "The request could not be confirmed. Refresh work status or retry confirmation using the same saved request.",
        );
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  if (demo) return null;
  return (
    <section className="intake-work" aria-label="Intake work requests">
      <div className="intake-heading">
        <div>
          <h3>Work requests</h3>
          <p>
            Save a request for a specific intake revision. Editing an intake
            never submits work automatically.
          </p>
        </div>
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => void refresh()}
        >
          Refresh work status
        </button>
      </div>
      <p className="intake-honesty">
        {!status
          ? "Work availability has not been confirmed."
          : !status.enabled
            ? "Work requests are disabled."
            : !status.dispatchEnabled
              ? "Requests can be saved. Processing is disabled; saving does not start a download."
              : "Processing is enabled. Saving a request does not mean media has been downloaded or approved."}
      </p>
      <p className="muted">
        Original and final-cut approval remain separate. No work status grants
        approval.
      </p>
      {storageError && (
        <p role="alert" className="intake-warning">
          {storageError}
        </p>
      )}
      {message && (
        <p role="status" className="intake-feedback">
          {message}
        </p>
      )}
      {pending && (
        <div className="intake-warning">
          <p>
            An unconfirmed{" "}
            {pending.kind === "save"
              ? "work request"
              : pending.kind === "range"
                ? "range selection"
                : "retry"}{" "}
            is kept for intake {pending.intakeId}.
            {pending.kind === "save"
              ? ` Revision ${pending.expectedRevision} · ${pending.priority} priority.`
              : pending.kind === "range"
                ? ` Source seconds ${pending.input.range.startSeconds}–${pending.input.range.endSeconds}.`
                : ` Attempt ${pending.expectedAttempt}.`}
          </p>
          <button
            type="button"
            disabled={busy || disabled || !status?.enabled || !!storageError}
            onClick={() => void send(pending)}
          >
            Retry work confirmation
          </button>
          {pending.kind === "range" && (
            <button
              type="button"
              disabled={busy || disabled || !!storageError}
              onClick={() => void clearPending(pending)}
            >
              Discard saved range confirmation (does not cancel work)
            </button>
          )}
        </div>
      )}
      {items
        .filter((item) => item.status !== "cancelled")
        .map((item) => {
          const jobs =
            status?.jobs.filter((job) => job.intakeId === item.id) ?? [];
          const currentJob = jobs.find(
            (job) => job.intakeRevision === item.revision,
          );
          const draftMismatch = hasDraftChanges(item);
          return (
            <article key={item.id} className="intake-work-card">
              <div className="intake-card-main">
                <a href={`#intake-${item.id}`}>
                  View saved intake · revision {item.revision}
                </a>
                {!item.episodeId && (
                  <p>
                    Assign an episode and save the intake before requesting
                    work.
                  </p>
                )}
                {draftMismatch && (
                  <p className="intake-warning">
                    Your local draft differs from the saved intake. Work uses
                    saved revision {item.revision}; save or discard your edits
                    first.
                  </p>
                )}
                {jobs.map((job) => (
                  <div
                    key={job.jobId}
                    className="intake-feedback intake-work-status"
                  >
                    <p>
                      {intakeWorkLabel(job)} · revision {job.intakeRevision} ·{" "}
                      {job.priority} priority · attempt {job.attempt}
                    </p>
                    {job.intakeRevision !== item.revision && (
                      <p>
                        This request uses an older immutable revision. The
                        current intake is revision {item.revision}; it has not
                        been resubmitted.
                      </p>
                    )}
                    {job.stale && (
                      <p>
                        Status may be stale. Refresh before relying on this
                        progress.
                      </p>
                    )}
                    {job.code && <p>Detail: {job.code}</p>}
                    <small>Last update: {job.updatedAt}</small>
                    {job.cutRequest && (
                      <p>
                        Cut request: {job.cutRequest.state}. Review the original
                        and any final cut separately in inventory.
                      </p>
                    )}
                    {job.rangeSelection &&
                      job.stage === "needs_direction" &&
                      job.cutRequest?.spec.kind === "first_pass" &&
                      !job.cutRequest.proposal && (
                        <IntakeRangeForm
                          owner={owner}
                          job={job}
                          disabled={
                            busy ||
                            disabled ||
                            !!pending ||
                            !status?.enabled ||
                            !!storageError ||
                            job.stale ||
                            job.intakeRevision !== item.revision ||
                            draftMismatch
                          }
                          onSubmit={(input) =>
                            void send({
                              kind: "range",
                              intakeId: item.id,
                              jobId: job.jobId,
                              input,
                            })
                          }
                        />
                      )}
                    {job.retryable === true && (
                      <button
                        type="button"
                        disabled={
                          busy ||
                          disabled ||
                          !!pending ||
                          !status?.enabled ||
                          !!storageError ||
                          job.intakeRevision !== item.revision ||
                          draftMismatch
                        }
                        onClick={() =>
                          void send({
                            kind: "retry",
                            intakeId: item.id,
                            jobId: job.jobId,
                            expectedAttempt: job.attempt,
                            expectedTargetId: job.retryTargetId ?? job.jobId,
                          })
                        }
                      >
                        Retry work request
                      </button>
                    )}
                  </div>
                ))}
                {!currentJob && (
                  <>
                    <label>
                      Priority{" "}
                      <select
                        aria-label={`Work priority for ${item.id}`}
                        value={priority[item.id] ?? "normal"}
                        disabled={
                          busy ||
                          disabled ||
                          !!pending ||
                          !status?.enabled ||
                          !!storageError
                        }
                        onChange={(event) =>
                          setPriority((previous) => ({
                            ...previous,
                            [item.id]: event.target.value as IntakeWorkPriority,
                          }))
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={
                        busy ||
                        disabled ||
                        !!pending ||
                        !status?.enabled ||
                        !!storageError ||
                        !item.episodeId ||
                        draftMismatch
                      }
                      onClick={() =>
                        void send({
                          kind: "save",
                          intakeId: item.id,
                          expectedRevision: item.revision,
                          priority: priority[item.id] ?? "normal",
                        })
                      }
                    >
                      Save work request
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
    </section>
  );
}
