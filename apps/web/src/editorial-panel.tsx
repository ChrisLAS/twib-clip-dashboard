import { useEffect, useRef, useState } from "react";
import type {
  EditorialProfile,
  EditorialContext,
  EditorialRule,
  EditorialScope,
} from "@twib/shared";
type Attempt = { path: string; body: Record<string, unknown> };
type Draft = {
  editId?: string | null;
  editVersion?: number;
  reason: string;
  text: string;
  scope: EditorialScope;
  attempt: Attempt | null;
};
const blank: Draft = { reason: "", text: "", scope: "episode", attempt: null };
function readDraft(key: string): Draft {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? blank;
  } catch {
    return blank;
  }
}
async function request<T>(
  path: string,
  csrf?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    ...(body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf ?? "",
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      value.error?.message ?? `Request failed (${response.status})`,
    );
  return value;
}
export function EditorialPanel({
  csrf,
  episodeId,
  renderId,
  demo,
}: {
  csrf: string;
  episodeId: string;
  renderId?: string;
  demo: boolean;
}) {
  const key = `editorial-draft:${demo ? "demo" : "live"}:${episodeId}:${renderId ?? ""}`;
  const [draft, setDraft] = useState<Draft>(() => readDraft(key));
  const [profile, setProfile] = useState<EditorialProfile | null>(null);
  const [context, setContext] = useState<EditorialContext | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const mutationLock = useRef(false);
  const loadGeneration = useRef(0);
  const editId = draft.editId ?? null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* Keep the in-memory draft if storage is unavailable. */
    }
  }, [draft, key]);
  async function load() {
    const generation = ++loadGeneration.current;
    setBusy(true);
    setError("");
    try {
      const [p, c] = await Promise.all([
        request<EditorialProfile>("/api/editorial/profile"),
        request<EditorialContext>(
          `/api/editorial/context?episodeId=${encodeURIComponent(episodeId)}${renderId ? `&renderId=${encodeURIComponent(renderId)}` : ""}`,
        ),
      ]);
      if (alive.current && generation === loadGeneration.current) {
        setProfile(p);
        setContext(c);
      }
    } catch (e) {
      if (alive.current)
        setError(
          e instanceof Error ? e.message : "Unable to load editorial context.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    ++loadGeneration.current;
    setBusy(true);
    setError("");
    const saved = { ...draft, attempt };
    setDraft(saved);
    try {
      sessionStorage.setItem(key, JSON.stringify(saved));
    } catch {
      /* In-memory retry is retained. */
    }
    try {
      const p = await request<EditorialProfile>(
        attempt.path,
        csrf,
        attempt.body,
      );
      const clean = {
        ...draft,
        attempt: null,
        reason: "",
        text: "",
        editId: null,
        editVersion: undefined,
      };
      try {
        sessionStorage.setItem(key, JSON.stringify(clean));
      } catch {
        /* No storage available. */
      }
      if (alive.current) {
        setDraft(clean);
        setProfile(p);

        await load();
      }
    } catch (e) {
      if (alive.current)
        setError(
          `${e instanceof Error ? e.message : "Save failed."} Your draft and exact retry are preserved. Reload to inspect current state; retry sends the same operation key.`,
        );
    } finally {
      mutationLock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function mutation(path: string, body: Record<string, unknown>) {
    if (!profile || draft.attempt) return;
    void send({
      path,
      body: {
        expectedRevision: profile.version,
        idempotencyKey: crypto.randomUUID(),
        reason: draft.reason,
        scope: draft.scope,
        ...body,
      },
    });
  }
  function ruleSave() {
    if (!profile) return;
    const target = editId ? profile.rules.find((r) => r.id === editId) : null;
    const rule: EditorialRule = {
      id: target?.id ?? crypto.randomUUID(),
      text: draft.text,
      scope: draft.scope,
      episodeId: target
        ? target.episodeId
        : draft.scope === "global"
          ? null
          : episodeId,
      renderId: target
        ? target.renderId
        : draft.scope === "render"
          ? (renderId ?? null)
          : null,
      evidenceIds: target?.evidenceIds ?? [],
    };
    mutation("/api/editorial/profile", {
      action: "replace",
      ...(editId ? { expectedRevision: draft.editVersion } : {}),
      rules: [...profile.rules.filter((r) => r.id !== rule.id), rule],
    });
  }
  const disabled = busy || !!draft.attempt;
  const valid = !!draft.reason.trim();
  return (
    <details
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        if (next && !profile && !busy) void load();
      }}
    >
      <summary>Editorial profile & feedback</summary>
      {open && (
        <div className="card">
          <p>
            Approved rules guide future work. Opening this panel does not mean a
            producer used them.
          </p>
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">Working…</p>}
          {profile && (
            <>
              <p>
                Version {profile.version} ·{" "}
                {profile.enabled ? "Enabled" : "Disabled"} ·{" "}
                {context?.loadedStatus === "reported_loaded"
                  ? "Context use reported"
                  : "No producer-use receipt for this context"}
              </p>
              <p>
                Review evidence: {context?.coverage.reviewCount ?? 0} examples;{" "}
                {context?.coverage.blankReasonCount ?? 0} without reasons. No
                preferences inferred from blank notes.
              </p>
              <label>
                Scope{" "}
                <select
                  aria-label="Scope"
                  value={draft.scope}
                  disabled={disabled || !!editId}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      scope: e.target.value as EditorialScope,
                    })
                  }
                >
                  <option value="episode">Current episode</option>
                  <option value="global">Future work (all episodes)</option>
                  {renderId && (
                    <option value="render">This exact render</option>
                  )}
                </select>
              </label>
              <label>
                Explicit reason{" "}
                <textarea
                  value={draft.reason}
                  disabled={disabled}
                  onChange={(e) =>
                    setDraft({ ...draft, reason: e.target.value })
                  }
                />
              </label>
              <label>
                Rule or proposed learning{" "}
                <textarea
                  value={draft.text}
                  disabled={disabled}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                />
              </label>
              <button
                disabled={disabled || !valid || !draft.text.trim()}
                onClick={ruleSave}
              >
                {editId ? "Save rule edit" : "Add approved rule"}
              </button>
              {editId && (
                <button
                  disabled={disabled}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      editId: null,
                      editVersion: undefined,
                      text: "",
                    })
                  }
                >
                  Cancel rule edit
                </button>
              )}
              <button
                disabled={disabled || !valid || !draft.text.trim() || !!editId}
                onClick={() =>
                  mutation("/api/editorial/feedback", {
                    action: "propose",
                    decision: "clear",
                    ruleText: draft.text,
                    episodeId: draft.scope === "global" ? null : episodeId,
                    renderId: draft.scope === "render" ? renderId : null,
                  })
                }
              >
                Propose learning for confirmation
              </button>
              <button
                disabled={disabled || !valid}
                onClick={() =>
                  mutation("/api/editorial/profile", {
                    action: profile.enabled ? "disable" : "enable",
                  })
                }
              >
                {profile.enabled ? "Disable" : "Enable"} guidance
              </button>
              <button
                disabled={disabled || !valid || profile.version < 1}
                onClick={() =>
                  mutation("/api/editorial/profile", {
                    action: "undo",
                    undoVersion: Math.max(0, profile.version - 1),
                  })
                }
              >
                Restore previous version’s rules
              </button>
              <ul>
                {profile.rules.map((r) => (
                  <li key={r.id}>
                    {r.text} ({r.scope}){" "}
                    <button
                      disabled={
                        disabled ||
                        (r.scope === "render" && r.renderId !== renderId) ||
                        (r.scope !== "global" && r.episodeId !== episodeId)
                      }
                      onClick={() => {
                        setDraft({
                          ...draft,
                          text: r.text,
                          scope: r.scope,
                          editId: r.id,
                          editVersion: profile.version,
                        });
                      }}
                    >
                      Edit
                    </button>{" "}
                    <button
                      disabled={disabled || !valid}
                      onClick={() =>
                        mutation("/api/editorial/profile", {
                          action: "replace",
                          rules: profile.rules.filter((x) => x.id !== r.id),
                        })
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <h4>Pending proposals</h4>
              {profile.proposals
                .filter((p) => p.status === "pending")
                .map((p) => (
                  <p key={p.id}>
                    {p.rule.text} ({p.rule.scope}){" "}
                    <button
                      disabled={disabled || !valid}
                      onClick={() =>
                        mutation("/api/editorial/feedback", {
                          action: "confirm",
                          decision: "clear",
                          proposalId: p.id,
                          scope: p.rule.scope,
                          episodeId: p.rule.episodeId,
                          renderId: p.rule.renderId,
                        })
                      }
                    >
                      Confirm rule
                    </button>{" "}
                    <button
                      disabled={disabled || !valid}
                      onClick={() =>
                        mutation("/api/editorial/feedback", {
                          action: "dismiss",
                          decision: "clear",
                          proposalId: p.id,
                          scope: p.rule.scope,
                          episodeId: p.rule.episodeId,
                          renderId: p.rule.renderId,
                        })
                      }
                    >
                      Dismiss
                    </button>
                  </p>
                ))}
            </>
          )}
          <button disabled={busy} onClick={() => void load()}>
            Reload context
          </button>
          {draft.attempt && (
            <>
              <button disabled={busy} onClick={() => void send(draft.attempt!)}>
                Retry exact save
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Have you reloaded and checked whether the previous save completed? This releases the saved retry but keeps your text.",
                    )
                  )
                    setDraft({ ...draft, attempt: null });
                }}
              >
                Release checked retry
              </button>
            </>
          )}
        </div>
      )}
    </details>
  );
}
