import { useEffect, useRef, useState } from "react";
import type { AiringDecisionInput, AiringEvidenceList } from "@twib/shared";
import { timecode } from "./api";
interface Pending {
  evidenceId: string;
  input: AiringDecisionInput;
}
export function AiringPanel({
  csrf,
  renderId,
  demo,
}: {
  csrf: string;
  renderId: string;
  demo: boolean;
}) {
  const storageKey = `twib-airing-${demo ? "demo" : "live"}-${renderId}`;
  const [open, setOpen] = useState(false),
    [data, setData] = useState<AiringEvidenceList | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [note, setNote] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey + "-note") || "";
    } catch {
      return "";
    }
  });
  const [verified, setVerified] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(
        sessionStorage.getItem(storageKey + "-pending") || "null",
      );
    } catch {
      return null;
    }
  });
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function load() {
    if (demo) return;
    const response = await fetch(
      `/api/renders/${encodeURIComponent(renderId)}/airing`,
      {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok)
      throw new Error(
        "Airing evidence is unavailable. Your review notes are unchanged.",
      );
    const next: AiringEvidenceList = await response.json();
    if (alive.current) {
      setData(next);
      setVerified(null);
    }
  }
  async function refresh() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await load();
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Could not load evidence.");
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function retain(value: Pending | null) {
    setPending(value);
    try {
      if (value)
        sessionStorage.setItem(storageKey + "-pending", JSON.stringify(value));
      else sessionStorage.removeItem(storageKey + "-pending");
    } catch {
      /* In-memory request remains available. */
    }
  }
  async function save(request: Pending) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    retain(request);
    try {
      let response = await fetch(
        `/api/airing/${encodeURIComponent(request.evidenceId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          signal: AbortSignal.timeout(20000),
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
          body: JSON.stringify(request.input),
        },
      );
      if (!response.ok && response.status < 500) {
        const detail = await response.json();
        if (alive.current) retain(null);
        throw new Error(
          detail.error?.message ||
            "Verification was not saved. Refresh before retrying.",
        );
      }
      if (!response.ok)
        response = await fetch(
          `/api/operations/${encodeURIComponent(request.input.idempotencyKey)}`,
          {
            credentials: "same-origin",
            cache: "no-store",
            signal: AbortSignal.timeout(20000),
          },
        );
      if (!response.ok)
        throw new Error(
          "Save is uncertain. Retry confirmation reuses the exact request and cannot double-save.",
        );
      if (alive.current) {
        retain(null);
        setVerified(null);
      }
      await load();
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error
            ? e.message
            : "Save is uncertain. Retry confirmation with the same request.",
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <details
      className="workflow-panel"
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (next && !data) void refresh();
      }}
    >
      <summary>Airing evidence & owner verification</summary>
      {open && (
        <div className="workflow-content">
          <p>
            Matching words produce candidates only. No match means unknown.
            Verify the exact render against published playback before confirming
            full or partial use.
          </p>
          {demo ? (
            <p>Fictional demo: no published evidence.</p>
          ) : (
            <>
              {data && !data.evidence.length && !busy && !error && (
                <p>
                  No persisted evidence for this render. Candidate generation
                  runs in the separate offline producer; it is not connected to
                  an automatic runtime.
                </p>
              )}
              {data?.evidence.map((e) => (
                <article className="airing-evidence" key={e.id}>
                  <p>
                    <strong>
                      {e.status === "CANDIDATE"
                        ? "Candidate passage"
                        : "Unknown use"}
                    </strong>{" "}
                    · {e.freshness} · owner decision: {e.decision}
                  </p>
                  {e.sourceTranscriptAssetId && (
                    <p>
                      Machine transcript from this exact rendered file. Words
                      are unverified; original source-context mapping remains
                      unknown.
                    </p>
                  )}
                  {e.staleReason && <p role="status">{e.staleReason}</p>}
                  {!e.searchComplete && (
                    <p>
                      Search was bounded and incomplete. Absence is not evidence
                      of non-use.
                    </p>
                  )}
                  {e.passages.map((p, i) => (
                    <div key={i}>
                      <p>
                        Render {timecode(p.sourceRange.startMs)}–
                        {timecode(p.sourceRange.endMs)} · episode{" "}
                        {timecode(p.episodeRange.startMs)}–
                        {timecode(p.episodeRange.endMs)}
                      </p>
                      <p>{p.sourceExcerpt}</p>
                      <p>
                        {p.quality.replaceAll("_", " ")} · cue-level timing ·{" "}
                        {p.ambiguity === "multiple_locations"
                          ? "Multiple possible locations"
                          : "No ambiguity detected by bounded search"}
                      </p>
                    </div>
                  ))}
                  {e.note && <p>Saved verification note: {e.note}</p>}
                  <label>
                    <input
                      type="checkbox"
                      checked={verified === e.id}
                      disabled={busy || !!pending || e.freshness !== "current"}
                      onChange={(event) =>
                        setVerified(event.target.checked ? e.id : null)
                      }
                    />{" "}
                    I compared this exact clip render with published playback
                    for this evidence’s episode edition.
                  </label>
                  <div className="workflow-actions">
                    {(["full", "partial", "unknown", "undo"] as const).map(
                      (decision) => (
                        <button
                          key={decision}
                          disabled={
                            busy ||
                            !!pending ||
                            (["full", "partial"].includes(decision) &&
                              (verified !== e.id || e.freshness !== "current"))
                          }
                          onClick={() =>
                            void save({
                              evidenceId: e.id,
                              input: {
                                expectedRevision: e.revision,
                                idempotencyKey: crypto.randomUUID(),
                                decision,
                                note,
                                verification:
                                  verified === e.id
                                    ? "listened_compared_exact_render"
                                    : "none",
                              },
                            })
                          }
                        >
                          {decision === "undo"
                            ? "Undo confirmation"
                            : decision === "unknown"
                              ? "Mark unknown"
                              : `Confirm ${decision} use`}
                        </button>
                      ),
                    )}
                  </div>
                </article>
              ))}
              <label>
                Verification note
                <textarea
                  aria-label="Verification note"
                  value={note}
                  maxLength={3000}
                  disabled={busy || !!pending}
                  onChange={(e) => {
                    setNote(e.target.value);
                    try {
                      sessionStorage.setItem(
                        storageKey + "-note",
                        e.target.value,
                      );
                    } catch {
                      /* Retain in memory. */
                    }
                  }}
                />
              </label>
              <div className="workflow-actions">
                <button disabled={busy} onClick={() => void refresh()}>
                  Refresh airing evidence
                </button>
                {pending && (
                  <button disabled={busy} onClick={() => void save(pending)}>
                    Retry confirmation
                  </button>
                )}
              </div>
              {error && <p role="alert">{error}</p>}
            </>
          )}
        </div>
      )}
    </details>
  );
}
