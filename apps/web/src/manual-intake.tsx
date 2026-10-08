import { useEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
  ExternalLink,
  Link2,
  Plus,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import {
  safeUploadFolderUrl,
  validateIntakeRange,
  validateIntakeUrl,
} from "@twib/shared";
import type {
  ApiError,
  Episode,
  IntakeCreateInput,
  IntakeMutationResult,
  IntakeUpdateInput,
  ManualIntake,
} from "@twib/shared";
import { api, RequestError, UncertainIntakeError } from "./api";
import { intakeTime, parseIntakeTime, pendingIntakes } from "./intake-state";
import { readIntakeDraft, saveIntakeDraft } from "./intake-drafts";
import type { Fields, Attempt } from "./intake-drafts";

function blankFields(episodeId: string | null): Fields {
  return {
    url: "",
    episodeId: episodeId ?? "",
    kind: "already_cut",
    start: "",
    end: "",
    why: "",
  };
}
function fieldsFor(item: ManualIntake): Fields {
  return {
    url: item.submittedUrl,
    episodeId: item.episodeId ?? "",
    kind: item.kind,
    start: intakeTime(item.inMs),
    end: intakeTime(item.outMs),
    why: item.whyItMatters,
  };
}

export function ManualIntakePanel({
  episodes,
  episodeId,
  items,
  csrf,
  demo,
  hidden,
  disabled,
  onBusy,
  onSaved,
  onOpenRender,
}: {
  episodes: Episode[];
  episodeId: string | null;
  items: ManualIntake[];
  csrf: string;
  demo: boolean;
  hidden: boolean;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (result: IntakeMutationResult) => void;
  onOpenRender: (episodeId: string, renderId: string) => void;
}) {
  const initial = useRef(readIntakeDraft());
  const [open, setOpen] = useState(!!initial.current?.attempt),
    [editing, setEditing] = useState<string | null>(
      initial.current?.editing ?? null,
    );
  const [baselineRevision, setBaselineRevision] = useState<number | null>(
    initial.current?.baselineRevision ?? null,
  );
  const [fields, setFields] = useState<Fields>(
    initial.current?.fields ?? blankFields(episodeId),
  );
  const [attempt, setAttempt] = useState<Attempt | null>(
    initial.current?.attempt ?? null,
  );
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState(
      initial.current?.attempt
        ? "A previous save is unconfirmed. Retry confirmation before making changes."
        : "",
    );
  const [duplicateAttempt, setDuplicateAttempt] = useState<Attempt | null>(
    null,
  );
  const [duplicate, setDuplicate] = useState<ApiError | null>(null),
    [confirmCancel, setConfirmCancel] = useState(false),
    [conflict, setConflict] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null),
    [savedNotice, setSavedNotice] = useState("");
  const dialog = useRef<HTMLElement>(null),
    startInput = useRef<HTMLInputElement>(null),
    busyRef = useRef(false);
  const current = items.find((item) => item.id === editing);
  const assigned = pendingIntakes(items, episodeId);
  const unassigned = episodeId === null ? [] : pendingIntakes(items, null);
  const cancelled = items.filter(
    (item) =>
      item.status === "cancelled" &&
      (item.episodeId === episodeId || item.episodeId === null),
  );
  const folder = safeUploadFolderUrl(
    episodes.find((episode) => episode.id === fields.episodeId)
      ?.uploadFolderUrl,
  );
  useEffect(() => {
    if (open) saveIntakeDraft({ fields, editing, baselineRevision, attempt });
  }, [open, fields, editing, baselineRevision, attempt]);
  useEffect(() => {
    if (!open || hidden) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
        ) ?? [],
      );
    focusable()[0]?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current && !attempt)
        setOpen(false);
      if (event.key !== "Tab") return;
      const list = focusable(),
        first = list[0],
        last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      previous?.focus();
    };
  }, [open, hidden, attempt]);

  function change<K extends keyof Fields>(key: K, value: Fields[K]) {
    setFields((previous) => ({ ...previous, [key]: value }));
    setDuplicate(null);
    setMessage("");
  }
  function begin(item?: ManualIntake) {
    if (attempt) {
      setOpen(true);
      return;
    }
    if (fields.url || fields.why || fields.start || fields.end)
      saveIntakeDraft({ fields, editing, baselineRevision, attempt });
    const stored = readIntakeDraft(item?.id ?? null);
    setFields(
      stored?.fields ?? (item ? fieldsFor(item) : blankFields(episodeId)),
    );
    setEditing(item?.id ?? null);
    setBaselineRevision(stored?.baselineRevision ?? item?.revision ?? null);
    setMessage("");
    setDuplicate(null);
    setConflict(false);
    setConfirmCancel(false);
    setOpen(true);
  }
  async function send(next: Attempt) {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    onBusy(true);
    setMessage("");
    setDuplicate(null);
    setAttempt(next);
    saveIntakeDraft({ fields, editing, baselineRevision, attempt: next });
    try {
      const result = next.id
        ? await api.updateIntake(next.id, next.body as IntakeUpdateInput, csrf)
        : await api.createIntake(next.body as IntakeCreateInput, csrf);
      onSaved(result);
      setAttempt(null);
      saveIntakeDraft(null);
      setOpen(false);
      setEditing(null);
      setConfirmCancel(false);
      setHighlight(result.intake.id);
      setFields(blankFields(episodeId));
      setBaselineRevision(null);
      setSavedNotice(
        result.intake.status === "cancelled"
          ? "Intake cancelled. Source files are unchanged."
          : `Saved · awaiting processing${result.intake.episodeId ? ` for Episode ${episodes.find((episode) => episode.id === result.intake.episodeId)?.number ?? "workspace"}` : " · Unassigned"}. No processor is connected yet.`,
      );
    } catch (error) {
      if (!(error instanceof UncertainIntakeError)) {
        setAttempt(null);
        saveIntakeDraft({ fields, editing, baselineRevision, attempt: null });
      }
      if (
        error instanceof RequestError &&
        error.details?.duplicateMatches?.length
      ) {
        setDuplicate(error.details);
        setDuplicateAttempt(next);
      }
      if (
        error instanceof RequestError &&
        error.status === 409 &&
        !error.details?.duplicateMatches?.length
      )
        setConflict(true);
      setMessage(
        error instanceof Error ? error.message : "Could not save this intake.",
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
      onBusy(false);
    }
  }
  function submit(allowDifferentRange = false) {
    if (attempt) {
      void send(attempt);
      return;
    }
    const url = validateIntakeUrl(fields.url);
    if (!url.ok) {
      setMessage(url.error);
      return;
    }
    const inMs = parseIntakeTime(fields.start),
      outMs = parseIntakeTime(fields.end);
    const rangeError = validateIntakeRange(inMs, outMs);
    if (rangeError) {
      setMessage(rangeError);
      return;
    }
    const common = {
      episodeId: fields.episodeId || null,
      inMs,
      outMs,
      whyItMatters: fields.why.trim(),
      allowDifferentRange,
      idempotencyKey: crypto.randomUUID(),
    };
    if (editing) {
      if (!current) {
        setMessage(
          "This intake is no longer in the loaded slate. Close and refresh before editing.",
        );
        return;
      }
      void send({
        id: editing,
        body: {
          ...common,
          action: "update",
          expectedRevision: baselineRevision ?? current.revision,
        },
      });
    } else
      void send({
        id: null,
        body: {
          ...common,
          kind: fields.kind,
          url: url.submittedUrl,
          expectedRevision: 0,
        },
      });
  }
  function changeStatus(action: "cancel" | "restore") {
    if (!current) return;
    void send({
      id: current.id,
      body: {
        action,
        expectedRevision: baselineRevision ?? current.revision,
        idempotencyKey: crypto.randomUUID(),
      },
    });
  }
  async function reloadLatest() {
    if (!editing || busyRef.current) return;
    busyRef.current = true;
    setSaving(true);
    onBusy(true);
    try {
      const latest = await api.intakes();
      const item = latest.items.find((entry) => entry.id === editing);
      if (!item) {
        setMessage("This intake is unavailable. Your draft is kept.");
        return;
      }
      onSaved({ intake: item, intakeVersion: latest.version });
      setFields(fieldsFor(item));
      setBaselineRevision(item.revision);
      setConflict(false);
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not reload this intake. Your draft is kept.",
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
      onBusy(false);
    }
  }
  function openDuplicate() {
    const match =
      duplicate?.duplicateMatches?.find(
        (match) => match.rangeMatch === "exact",
      ) ?? duplicate?.duplicateMatches?.[0];
    if (!match) return;
    setOpen(false);
    if (match.kind === "render" && match.episodeId)
      onOpenRender(match.episodeId, match.id);
    else {
      const existing = items.find((item) => item.id === match.id);
      if (existing) begin(existing);
      else {
        setSavedNotice(
          "That submission was saved elsewhere. Refresh the slate to load its latest details.",
        );
        setHighlight(match.id);
      }
    }
  }
  function row(item: ManualIntake) {
    const source = validateIntakeUrl(item.submittedUrl);
    return (
      <article
        className={`intake-card${highlight === item.id ? " intake-highlight" : ""}`}
        key={item.id}
        id={`intake-${item.id}`}
      >
        <div className="intake-icon">
          <Link2 size={20} aria-hidden="true" />
        </div>
        <div className="intake-card-main">
          <div className="intake-card-tags">
            <span className="eyebrow copper">Added by you</span>
            <span className="pill">
              {item.kind === "already_cut" ? "Already-cut clip" : "Full source"}
            </span>
          </div>
          {source.ok ? (
            <a
              className="intake-source"
              href={source.submittedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {source.submittedUrl}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ) : (
            <span>Source link unavailable</span>
          )}
          {item.whyItMatters && <p>{item.whyItMatters}</p>}
          <small>
            {item.inMs !== null && item.outMs !== null
              ? `${intakeTime(item.inMs)}–${intakeTime(item.outMs)} · source time`
              : "No time range specified"}
          </small>
          <span className="intake-status">
            <Clock3 size={13} aria-hidden="true" />
            {item.status === "cancelled"
              ? "Cancelled"
              : "Saved · awaiting processing"}
          </span>
        </div>
        <button
          className="quiet"
          disabled={disabled || saving}
          onClick={() => begin(item)}
        >
          {item.status === "cancelled"
            ? "View cancelled intake"
            : "Edit intake"}
        </button>
      </article>
    );
  }
  return (
    <section
      className="manual-intake"
      hidden={hidden}
      aria-label="Manual intake"
    >
      <div className="intake-heading">
        <div>
          <p className="eyebrow copper">YOUR PICKS</p>
          <h2>
            Added by you <span>{assigned.length}</span>
          </h2>
          <p>
            Save a clip or a longer source alongside this episode’s review
            slate.
          </p>
        </div>
        <button
          className="primary-action"
          disabled={disabled || saving || demo}
          onClick={() => begin()}
        >
          <Plus size={17} />
          Add clip or source
        </button>
      </div>
      <p className="intake-honesty">
        {demo
          ? "Manual intake is unavailable in the fictional demo."
          : "No processor is connected yet. Saved submissions await processing; they are not playable clips or ready for review."}
      </p>
      {savedNotice && (
        <p className="intake-feedback" role="status">
          <Check size={16} />
          {savedNotice}
        </p>
      )}
      {assigned.map(row)}
      {!assigned.length && (
        <div className="intake-empty">
          Nothing added to this episode yet. Paste a source link when you find
          something worth considering.
        </div>
      )}
      {!!unassigned.length && (
        <div className="unassigned-intakes">
          <h3>
            Unassigned <span>{unassigned.length}</span>
          </h3>
          <p className="muted">
            Saved for later. Assign an episode from Edit intake.
          </p>
          {unassigned.map(row)}
        </div>
      )}
      {!!cancelled.length && (
        <details className="cancelled-intakes">
          <summary>Cancelled submissions ({cancelled.length})</summary>
          {cancelled.map(row)}
        </details>
      )}
      {open && (
        <div className="intake-backdrop">
          <section
            ref={dialog}
            className="intake-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="intake-title"
          >
            <div className="intake-dialog-heading">
              <div>
                <p className="eyebrow copper">MANUAL INTAKE</p>
                <h2 id="intake-title">
                  {editing ? "Edit your submission" : "Add to your slate"}
                </h2>
              </div>
              <button
                className="quiet"
                aria-label="Close intake"
                disabled={saving || !!attempt}
                onClick={() => setOpen(false)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="muted">
              Save the source and your context now. Processing and playable
              renders will come later.
            </p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <fieldset disabled={saving || !!attempt || conflict}>
                <label>
                  Source URL or private Drive link
                  <input
                    type="url"
                    required
                    maxLength={2048}
                    value={fields.url}
                    disabled={!!editing}
                    onChange={(event) => change("url", event.target.value)}
                    placeholder="https://…"
                    autoComplete="off"
                  />
                </label>
                {editing && (
                  <small className="muted">
                    The saved source and source type stay attached to this
                    record. Add a new submission for another source.
                  </small>
                )}
                <div className="intake-form-grid">
                  <label>
                    Episode assignment
                    <select
                      value={fields.episodeId}
                      onChange={(event) =>
                        change("episodeId", event.target.value)
                      }
                    >
                      <option value="">Unassigned</option>
                      {episodes.map((episode) => (
                        <option key={episode.id} value={episode.id}>
                          Episode {episode.number} · {episode.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Source type
                    <select
                      value={fields.kind}
                      disabled={!!editing}
                      onChange={(event) =>
                        change("kind", event.target.value as Fields["kind"])
                      }
                    >
                      <option value="already_cut">Already-cut clip</option>
                      <option value="full_source">Full source</option>
                    </select>
                  </label>
                </div>
                <div className="intake-form-grid">
                  <label>
                    Start time <span className="muted">(optional)</span>
                    <input
                      ref={startInput}
                      inputMode="decimal"
                      placeholder="0:00"
                      value={fields.start}
                      onChange={(event) => change("start", event.target.value)}
                    />
                  </label>
                  <label>
                    End time <span className="muted">(optional)</span>
                    <input
                      inputMode="decimal"
                      placeholder="1:30"
                      value={fields.end}
                      onChange={(event) => change("end", event.target.value)}
                    />
                  </label>
                </div>
                <small className="muted">
                  Use seconds, m:ss or h:mm:ss. Provide both times, or leave
                  both blank. Times refer to the source. Timestamps in pasted
                  links are not imported; enter your intended range here.
                </small>
                <label>
                  Why it matters <span className="muted">(optional)</span>
                  <textarea
                    maxLength={4000}
                    rows={3}
                    placeholder="The point, moment or angle worth considering…"
                    value={fields.why}
                    onChange={(event) => change("why", event.target.value)}
                  />
                </label>
              </fieldset>
              <div className="intake-upload">
                <Upload size={19} aria-hidden="true" />
                <div>
                  <strong>Have a local file?</strong>
                  {folder ? (
                    <>
                      <p>
                        Upload it yourself to the configured private episode
                        folder, then paste the Drive file link above. The
                        dashboard does not upload files.
                      </p>
                      <a
                        href={folder}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open private episode upload folder{" "}
                        <ExternalLink size={13} />
                      </a>
                    </>
                  ) : (
                    <p>
                      {fields.episodeId
                        ? "No private upload folder is configured for this episode."
                        : "Choose an episode with a configured private upload folder."}{" "}
                      You can still paste an existing private Drive file link.
                      Direct upload is unavailable.
                    </p>
                  )}
                </div>
              </div>
              {message && (
                <div className="intake-warning" role="alert">
                  <TriangleAlert size={17} />
                  <div>
                    {message}
                    {conflict && (
                      <>
                        <p>
                          The server revision changed. Your edits are kept. Use
                          the button below only when you want to replace your
                          edits with the latest server record.
                        </p>
                        {current && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => void reloadLatest()}
                          >
                            Discard edits and reload latest
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
              {duplicate && (
                <div className="intake-duplicate">
                  <p>
                    This source is already in the workspace. Open it, or
                    deliberately save a different cut.
                  </p>
                  <button type="button" onClick={openDuplicate}>
                    Open existing
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        duplicate.duplicateMatches?.some(
                          (match) => match.rangeMatch === "exact",
                        )
                      ) {
                        setDuplicate(null);
                        setMessage(
                          "Change the start and end times for a different cut. An identical source and range cannot be added again.",
                        );
                        startInput.current?.focus();
                      } else if (duplicateAttempt)
                        void send({
                          ...duplicateAttempt,
                          body: {
                            ...duplicateAttempt.body,
                            allowDifferentRange: true,
                            idempotencyKey: crypto.randomUUID(),
                          },
                        });
                    }}
                  >
                    Different cut
                  </button>
                </div>
              )}
              {confirmCancel && (
                <div className="intake-warning">
                  <p>
                    Cancel this pending submission? It will stay in the
                    cancelled list. No source file will be changed.
                  </p>
                  <button
                    type="button"
                    disabled={saving || !!attempt}
                    onClick={() => changeStatus("cancel")}
                  >
                    Confirm cancel
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setConfirmCancel(false)}
                  >
                    Keep intake
                  </button>
                </div>
              )}
              <div className="intake-form-actions">
                {current &&
                  !attempt &&
                  !conflict &&
                  (current.status === "cancelled" ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => changeStatus("restore")}
                    >
                      Restore intake
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="quiet"
                      disabled={saving}
                      onClick={() => setConfirmCancel(true)}
                    >
                      Cancel intake
                    </button>
                  ))}
                <span />
                {!attempt && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={saving}
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </button>
                )}
                <button
                  type="submit"
                  className="primary-action"
                  disabled={
                    saving ||
                    conflict ||
                    !!duplicate ||
                    (!attempt && current?.status === "cancelled")
                  }
                >
                  {saving
                    ? "Saving…"
                    : attempt
                      ? "Retry confirmation"
                      : editing
                        ? "Save changes"
                        : "Save intake"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
