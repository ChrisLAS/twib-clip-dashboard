import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Film,
  Headphones,
  LayoutList,
  RefreshCw,
  Search,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  X,
  Keyboard,
  Radio,
  Undo2,
} from "lucide-react";
import type {
  Clip,
  Decision,
  EpisodeDetail,
  Review,
  Session,
} from "@twib/shared";
import { api, date, duration, RequestError, timecode } from "./api";
import { demoEpisode, thumbnail } from "./demo";
import "./style.css";
import { canSeekMedia, productionLabel } from "./review-state";
import { readDraft, storeDraft } from "./drafts";
const labels: Record<Decision, string> = {
  up: "Approved",
  down: "Rejected",
  defer: "Deferred",
  clear: "Not reviewed",
};
const isLocalDemo =
  new URLSearchParams(location.search).get("demo") === "1" &&
  ["localhost", "127.0.0.1"].includes(location.hostname);
function App() {
  const [episode, setEpisode] = useState<EpisodeDetail | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [filter, setFilter] = useState("All clips"),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("order"),
    [notice, setNotice] = useState(""),
    [help, setHelp] = useState(false),
    [blockers, setBlockers] = useState(false),
    [shortcuts, setShortcuts] = useState(false);
  const [pending, setPending] = useState(false),
    [saveError, setSaveError] = useState(""),
    [undo, setUndo] = useState<{
      clipId: string;
      renderId: string;
      committedRevision: number;
      review: Review;
    } | null>(null);
  const mutationLock = useRef(false);
  const drafts = useRef(new Map<string, { note: string; reason: string }>());
  const scroll = useRef(0),
    openButton = useRef<HTMLElement | null>(null);
  const demo = isLocalDemo || session?.mode === "demo";
  async function load() {
    setLoading(true);
    setError("");
    try {
      if (isLocalDemo) {
        setEpisode((previous) => previous ?? structuredClone(demoEpisode));
        setSession({
          csrfToken: "",
          mode: "demo",
          owner: "Local reviewer",
          integrations: { drive: false, producer: false },
        });
      } else {
        const s = await api.session();
        setSession(s);
        const eps = await api.episodes();
        if (eps.length) setEpisode(await api.episode(eps[0].id));
        else setEpisode(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the slate");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const fn = () => {
      const id = history.state?.clipId || null;
      setSelected(id);
      if (!id) requestAnimationFrame(() => window.scrollTo(0, scroll.current));
    };
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  function open(clip: Clip) {
    if (!selected) {
      scroll.current = window.scrollY;
      openButton.current = document.activeElement as HTMLElement;
    }
    setSelected(clip.id);
    setSaveError("");
    history.pushState({ clipId: clip.id }, "", `#clip/${clip.id}`);
    window.scrollTo(0, 0);
  }
  function back() {
    setSelected(null);
    history.replaceState({}, "", location.pathname + location.search);
    requestAnimationFrame(() => {
      window.scrollTo(0, scroll.current);
      openButton.current?.focus();
    });
  }
  function update(id: string, fn: (c: Clip) => Clip) {
    setEpisode((prev) =>
      prev
        ? { ...prev, clips: prev.clips.map((c) => (c.id === id ? fn(c) : c)) }
        : prev,
    );
  }
  async function decide(
    clip: Clip,
    decision: Decision,
    note: string,
    reason: string,
    isUndo = false,
  ) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setPending(true);
    setSaveError("");
    setNotice("");
    const previous = { ...clip.render.review };
    try {
      const next = isLocalDemo
        ? await new Promise<Review>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  decision,
                  note,
                  reason,
                  revision: previous.revision + 1,
                  updatedAt: new Date().toISOString(),
                }),
              300,
            ),
          )
        : await api.review(
            clip.render.id,
            {
              decision,
              note,
              reason,
              expectedRevision: previous.revision,
              idempotencyKey: crypto.randomUUID(),
            },
            session!.csrfToken,
          );
      update(clip.id, (c) =>
        c.render.id === clip.render.id
          ? { ...c, render: { ...c.render, review: next } }
          : c,
      );
      setUndo(
        isUndo
          ? null
          : {
              clipId: clip.id,
              renderId: clip.render.id,
              committedRevision: next.revision,
              review: previous,
            },
      );
      setNotice(
        `${isLocalDemo ? "Demo decision updated in this session" : "Decision saved"} · ${labels[decision]}`,
      );
    } catch (e) {
      setSaveError(
        e instanceof RequestError && e.status === 409
          ? "This version changed elsewhere. Your note is kept here. Refresh the record before saving again."
          : e instanceof Error
            ? e.message
            : "Save failed. Your note is kept here.",
      );
    } finally {
      mutationLock.current = false;
      setPending(false);
    }
  }
  async function visibility(clip: Clip) {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setPending(true);
    setSaveError("");
    try {
      const v = clip.visibility === "visible" ? "hidden" : "visible";
      const r = isLocalDemo
        ? { visibility: v, revision: clip.visibilityRevision + 1 }
        : await api.visibility(
            clip.id,
            {
              visibility: v,
              expectedRevision: clip.visibilityRevision,
              idempotencyKey: crypto.randomUUID(),
            },
            session!.csrfToken,
          );
      update(clip.id, (c) => ({
        ...c,
        visibility: r.visibility as "visible" | "hidden",
        visibilityRevision: r.revision,
      }));
      setNotice(
        `${v === "hidden" ? "Hidden from slate" : "Restored to slate"}. Original files are retained.`,
      );
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Visibility could not be saved",
      );
    } finally {
      mutationLock.current = false;
      setPending(false);
    }
  }
  useEffect(() => {
    if (!help) return;
    const prev = document.activeElement as HTMLElement;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHelp(false);
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(
        document.querySelectorAll<HTMLElement>(".modal button,.modal input"),
      ).filter((x) => !(x as HTMLButtonElement).disabled);
      const first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      prev?.focus();
    };
  }, [help]);
  const clip = episode?.clips.find((c) => c.id === selected),
    visible =
      episode?.clips
        .filter((c) =>
          filter === "Hidden"
            ? c.visibility === "hidden"
            : c.visibility === "visible",
        )
        .filter((c) =>
          filter === "Approved"
            ? c.render.review.decision === "up"
            : filter === "Rejected"
              ? c.render.review.decision === "down"
              : filter === "Deferred"
                ? c.render.review.decision === "defer"
                : filter === "Unreviewed"
                  ? c.render.review.decision === "clear"
                  : true,
        )
        .filter((c) =>
          `${c.title} ${c.render.source.speaker} ${c.render.source.title}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "duration"
            ? a.render.durationMs - b.render.durationMs
            : sort === "speaker"
              ? a.render.source.speaker.localeCompare(b.render.source.speaker)
              : 0,
        ) || [];
  return (
    <>
      <header className="topbar">
        <a
          className="brand"
          href={location.pathname + location.search}
          onClick={(e) => {
            e.preventDefault();
            back();
          }}
        >
          <span className="bitcoin">₿</span>
          <strong>TWiB</strong>
          <span className="brand-divider" />
          <span className="desk">Editorial desk</span>
        </a>
        <span className="mode">
          <span className="mode-dot" />
          {demo ? "LOCAL DEMO · FICTIONAL SAMPLES" : "PRIVATE REVIEW WORKSPACE"}
        </span>
        <span className="identity">
          <ShieldCheck size={15} />
          {demo ? "Local reviewer" : session?.owner || "Owner access"}
        </span>
        <button
          className="quiet header-help"
          aria-label="Keyboard and review help"
          onClick={() => setHelp(true)}
        >
          <Keyboard size={17} />
        </button>
      </header>
      {!clip && (
        <aside className="rail">
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <button className="nav active" onClick={back}>
              <LayoutList size={17} />
              Episode slate
            </button>
            <p className="eyebrow space-top">CURRENT EPISODE</p>
            <div className="episode-nav">
              <span>{episode?.number ?? "—"}</span>
              <small>{episode?.title ?? "Review workspace"}</small>
            </div>
          </div>
          <button className="quiet" onClick={() => setHelp(true)}>
            <Keyboard size={16} />
            Keyboard & help
          </button>
        </aside>
      )}
      <main className={clip ? "review-main" : "slate-main"}>
        {demo && (
          <div className="demo-strip">
            <span>Demo workspace</span>Fictional sample metadata.{" "}
            {isLocalDemo
              ? "Decisions stay in this tab and reset on reload."
              : "Decisions are stored only in the local demo database."}{" "}
            Drive playback and producer updates are not connected.
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <TriangleAlert size={20} />
            <div>
              <strong>
                {episode
                  ? "Refresh failed. Showing previously loaded data."
                  : "Could not load this workspace"}
              </strong>
              <p>{error}</p>
            </div>
            <button onClick={load}>Try again</button>
            {!episode &&
              ["localhost", "127.0.0.1"].includes(location.hostname) && (
                <a className="button" href="?demo=1">
                  Open local demo
                </a>
              )}
          </div>
        )}
        {loading && !episode ? (
          <div className="loading" role="status">
            <RefreshCw className="spin" />
            Loading your review slate…
          </div>
        ) : !episode && !error ? (
          <div className="empty">
            <Film />
            <h1>No episodes yet</h1>
            <p>
              Clips will appear after an authorized producer manifest is
              imported.
            </p>
            <button onClick={load}>Refresh</button>
          </div>
        ) : (
          episode && (
            <>
              {clip ? (
                <ReviewDesk
                  key={clip.render.id}
                  initialDraft={
                    drafts.current.get(clip.render.id) ??
                    readDraft(clip.render.id)
                  }
                  onDraft={(note, reason) => {
                    drafts.current.set(clip.render.id, { note, reason });
                    storeDraft(
                      clip.render.id,
                      note === clip.render.review.note &&
                        reason === clip.render.review.reason
                        ? undefined
                        : { note, reason },
                    );
                  }}
                  clip={clip}
                  demo={!!demo}
                  pending={pending}
                  shortcuts={shortcuts}
                  onBack={back}
                  onDecide={decide}
                  onVisibility={visibility}
                  index={episode.clips.indexOf(clip)}
                  episodeNumber={episode.number}
                  total={episode.clips.length}
                  onNext={(delta) => {
                    const list = episode.clips;
                    const next = list[list.indexOf(clip) + delta];
                    if (next) open(next);
                  }}
                />
              ) : (
                <>
                  <div className="episode-heading">
                    <div>
                      <p className="eyebrow copper">THIS WEEK IN BITCOIN</p>
                      <h1>
                        Episode {episode.number}
                        <span className="heading-dot">.</span>
                      </h1>
                      <p className="subtitle">
                        {episode.title}
                        <span className="muted"> / Review slate</span>
                      </p>
                    </div>
                    <div className="header-state">
                      <span className="pill amber">
                        <Radio size={13} />
                        Aired outcome unverified
                      </span>
                      <button
                        className="quiet"
                        onClick={load}
                        disabled={loading}
                      >
                        <RefreshCw
                          size={14}
                          className={loading ? "spin" : ""}
                        />
                        {loading ? "Refreshing…" : "Refresh slate"}
                      </button>
                    </div>
                  </div>
                  {demo && (
                    <section className="direction">
                      <div className="direction-mark">↗</div>
                      <div>
                        <p className="eyebrow copper">
                          EDITORIAL DIRECTION{" "}
                          <span>· SUGGESTED, NOT APPROVED</span>
                        </p>
                        <p>
                          Build a clear throughline. Give every clip a distinct
                          job.
                        </p>
                        <small>
                          A fictional editorial prompt. Listen for a complete
                          thought, useful context, and a distinct angle.
                        </small>
                      </div>
                    </section>
                  )}
                  <section className="metrics" aria-label="Episode summary">
                    <div>
                      <strong>{episode.clips.length}</strong>
                      <span>candidate clips</span>
                    </div>
                    <div>
                      <strong>
                        {duration(
                          episode.clips.reduce(
                            (n, c) => n + c.render.durationMs,
                            0,
                          ),
                        )}
                      </strong>
                      <span>combined runtime</span>
                    </div>
                    <div>
                      <strong>
                        {
                          episode.clips.filter(
                            (c) => c.render.review.decision === "up",
                          ).length
                        }
                        <small> / {episode.clips.length}</small>
                      </strong>
                      <span>editorially approved</span>
                    </div>
                    <div className="last-update">
                      <Clock3 size={18} />
                      <span>
                        <b>
                          {episode.sync.lastSuccessAt
                            ? `Last import ${date(episode.sync.lastSuccessAt)}`
                            : "No verified producer update"}
                        </b>
                        <small>
                          {episode.sync.lastSuccessAt
                            ? "Refresh checks stored events only"
                            : "No live integration · producer status unknown"}
                        </small>
                      </span>
                    </div>
                  </section>
                  <div
                    className="tabs"
                    role="group"
                    aria-label="Filter by decision"
                  >
                    {[
                      "All clips",
                      "Unreviewed",
                      "Approved",
                      "Rejected",
                      "Deferred",
                      "Hidden",
                    ].map((t) => (
                      <button
                        key={t}
                        aria-pressed={filter === t}
                        className={filter === t ? "selected" : ""}
                        onClick={() => setFilter(t)}
                      >
                        {t}
                        {t === "All clips" && (
                          <span>
                            {
                              episode.clips.filter(
                                (c) => c.visibility === "visible",
                              ).length
                            }
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="toolbar">
                    <label className="search">
                      <Search size={17} />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search clips, speakers or sources"
                        aria-label="Search clips, speakers or sources"
                      />
                      {query && (
                        <button
                          aria-label="Clear search"
                          onClick={() => setQuery("")}
                        >
                          <X size={16} />
                        </button>
                      )}
                    </label>
                    <label className="sort">
                      Sort by
                      <select
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="order">Episode order</option>
                        <option value="duration">Shortest first</option>
                        <option value="speaker">Speaker A–Z</option>
                      </select>
                    </label>
                    <span className="result-count">{visible.length} clips</span>
                  </div>
                  <div className="clip-list">
                    <div className="list-head">
                      <span>CLIP / SOURCE</span>
                      <span>DURATION</span>
                      <span>SOURCE DATE</span>
                      <span>PRODUCTION / QA</span>
                      <span>DECISION</span>
                    </div>
                    {visible.map((c, i) => (
                      <button
                        key={c.id}
                        className="clip-row"
                        onClick={() => open(c)}
                        aria-label={`Review ${c.title} by ${c.render.source.speaker}`}
                      >
                        <div className="clip-identity">
                          <span className="row-number">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          {demo ? (
                            <img src={thumbnail(c)} alt="" />
                          ) : (
                            <span className="thumb-placeholder">
                              <Film size={22} />
                            </span>
                          )}
                          <div>
                            <strong>{c.render.source.speaker}</strong>
                            <span>{c.title}</span>
                            <small>{c.render.source.title}</small>
                          </div>
                        </div>
                        <div className="duration">
                          {duration(c.render.durationMs)}
                        </div>
                        <div className="source-date">
                          <span>
                            Published {date(c.render.source.publicationDate)}
                          </span>
                          <small>
                            {c.render.source.recordingDate
                              ? `Recorded ${date(c.render.source.recordingDate)}`
                              : "Recorded date unknown"}
                          </small>
                        </div>
                        <div className="production">
                          <span className="pill">
                            <span className="status-dot" />
                            {productionLabel(c.production)}
                          </span>
                          <small>
                            {c.render.qa.some((q) => q.result === "unknown")
                              ? "Playback check pending"
                              : "See QA evidence"}
                          </small>
                          <small className="last-progress">
                            Last progress:{" "}
                            {c.production.lastProgressAt
                              ? new Date(
                                  c.production.lastProgressAt,
                                ).toLocaleString()
                              : "unknown"}
                          </small>
                        </div>
                        <div className={`decision ${c.render.review.decision}`}>
                          <span>{labels[c.render.review.decision]}</span>
                          <ChevronRight size={17} />
                        </div>
                      </button>
                    ))}
                  </div>
                  {!visible.length && (
                    <div className="empty">
                      <Search />
                      <h2>
                        {episode.clips.length
                          ? "No clips match this view"
                          : "No clips yet"}
                      </h2>
                      <p>
                        {episode.clips.length
                          ? "Try another search or clear your filters."
                          : "This episode has no imported renders."}
                      </p>
                      <button
                        onClick={() => {
                          setFilter("All clips");
                          setQuery("");
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                  {episode.clips
                    .filter((c) => c.production.blocker)
                    .map((c) => (
                      <section className="blocker" key={c.id}>
                        <TriangleAlert size={20} />
                        <div>
                          <strong>{c.title} · production blocked</strong>
                          <p>{c.production.blocker}</p>
                          <p>
                            Last actual progress:{" "}
                            {c.production.lastProgressAt
                              ? new Date(
                                  c.production.lastProgressAt,
                                ).toLocaleString()
                              : "Unknown"}
                          </p>
                        </div>
                        <button onClick={() => open(c)}>
                          Review details
                          <ChevronRight size={15} />
                        </button>
                      </section>
                    ))}
                  {demo && (
                    <section className="blocker">
                      <TriangleAlert size={20} />
                      <div>
                        <strong>Example sources need attention</strong>
                        <p>
                          Fictional blocker · awaiting authorized source access.
                        </p>
                      </div>
                      <button onClick={() => setBlockers(!blockers)}>
                        {blockers ? "Close details" : "View blockers"}
                        <ChevronRight size={15} />
                      </button>
                    </section>
                  )}
                  {blockers && demo && (
                    <section className="blocker-details">
                      <h3>Source retrieval is blocked</h3>
                      <p>
                        This fictional example has no usable source artifact. In
                        a connected workspace, the producer’s specific blocker
                        and next action appear here. No live producer is
                        connected.
                      </p>
                      <p className="muted">
                        Last actual event: unknown. Refreshing the slate does
                        not restart production.
                      </p>
                    </section>
                  )}
                  <footer>
                    <span>
                      <ShieldCheck size={13} />
                      Private by design · originals stay in Drive
                    </span>
                    <span>Production ≠ approval ≠ airing</span>
                  </footer>
                </>
              )}
              {saveError && (
                <div className="save-error" role="alert">
                  <TriangleAlert size={18} />
                  <span>{saveError}</span>
                  <button onClick={load}>Refresh record</button>
                </div>
              )}
              {notice && (
                <div className="toast" role="status">
                  <Check size={18} />
                  <span>{notice}</span>
                  {undo && (
                    <button
                      disabled={pending}
                      onClick={() => {
                        const c = episode.clips.find(
                          (c) => c.id === undo.clipId,
                        );
                        if (
                          c &&
                          c.render.id === undo.renderId &&
                          c.render.review.revision === undo.committedRevision
                        )
                          void decide(
                            c,
                            undo.review.decision,
                            undo.review.note,
                            undo.review.reason,
                            true,
                          );
                        else {
                          setUndo(null);
                          setSaveError(
                            "Undo is no longer available because this render or review changed. No decision was changed.",
                          );
                        }
                      }}
                    >
                      <Undo2 size={14} />
                      Undo
                    </button>
                  )}
                  <button
                    className="icon"
                    aria-label="Dismiss notification"
                    onClick={() => setNotice("")}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
            </>
          )
        )}
      </main>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setHelp(false);
            }}
          >
            <button
              autoFocus
              className="icon close"
              aria-label="Close help"
              onClick={() => setHelp(false)}
            >
              <X />
            </button>
            <p className="eyebrow copper">REVIEW AT YOUR PACE</p>
            <h2 id="help-title">Keyboard & help</h2>
            <p>
              In the video player: Space to play or pause. Left and right arrows
              seek five seconds. Native controls also support volume, captions
              and fullscreen when available.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={shortcuts}
                onChange={(e) => setShortcuts(e.target.checked)}
              />
              Enable Alt+A to approve and Alt+R to reject
            </label>
            <p className="muted">
              Review shortcuts never run while typing a note. Hide is
              reversible; manage original files directly in Drive.
            </p>
            <button onClick={() => setHelp(false)}>Got it</button>
          </section>
        </div>
      )}
    </>
  );
}
function ReviewDesk({
  initialDraft,
  onDraft,
  clip,
  demo,
  pending,
  shortcuts,
  onBack,
  onDecide,
  onVisibility,
  index,
  total,
  onNext,
  episodeNumber,
}: {
  initialDraft?: { note: string; reason: string };
  onDraft: (note: string, reason: string) => void;
  clip: Clip;
  demo: boolean;
  pending: boolean;
  shortcuts: boolean;
  onBack: () => void;
  onDecide: (c: Clip, d: Decision, n: string, r: string) => void;
  onVisibility: (c: Clip) => void;
  index: number;
  episodeNumber: number;
  total: number;
  onNext: (d: number) => void;
}) {
  const r = clip.render,
    s = r.source,
    [note, setNote] = useState(initialDraft?.note ?? r.review.note),
    [reason, setReason] = useState(initialDraft?.reason ?? r.review.reason),
    [mediaError, setMediaError] = useState(""),
    [mediaReady, setMediaReady] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [context, setContext] = useState<"transcript" | "evidence">("transcript");
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (
        !shortcuts ||
        !e.altKey ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement).tagName,
        )
      )
        return;
      if (e.key.toLowerCase() === "a" || e.key.toLowerCase() === "r") {
        e.preventDefault();
        onDecide(
          clip,
          e.key.toLowerCase() === "a" ? "up" : "down",
          note,
          reason,
        );
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [shortcuts, clip, note, reason, pending]);
  useEffect(() => {
    onDraft(note, reason);
  }, [note, reason, r.review.note, r.review.reason]);
  const captions = React.useMemo(() => {
    if (!r.mappingVerified || !r.cues.length) return undefined;
    const vtt =
      "WEBVTT\n\n" +
      r.cues
        .map(
          (c) =>
            `${timecode(c.startMs)} --> ${timecode(c.endMs)}\n${c.text.replace(/-->/g, "→")}\n`,
        )
        .join("\n");
    return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
  }, [r.id, r.cues, r.mappingVerified]);
  useEffect(
    () => () => {
      if (captions) URL.revokeObjectURL(captions);
    },
    [captions],
  );
  function playerKeys(e: React.KeyboardEvent) {
    if (
      e.target !== video.current ||
      !video.current ||
      mediaError ||
      !mediaReady
    )
      return;
    const v = video.current;
    if (e.key === " ") {
      e.preventDefault();
      if (v.paused)
        void v
          .play()
          .catch(() =>
            setMediaError(
              "Playback could not start. Check access and try again.",
            ),
          );
      else v.pause();
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      v.currentTime = Math.max(
        0,
        Math.min(
          v.duration || r.durationMs / 1000,
          v.currentTime + (e.key === "ArrowRight" ? 5 : -5),
        ),
      );
    }
  }
  return (
    <>
      <div className="review-breadcrumb">
        <button className="quiet" onClick={onBack}>
          <ArrowLeft size={16} />
          Episode {episodeNumber}
          <span>/ Clip review</span>
        </button>
        <div className="next-clip">
          <span>
            {index + 1} of {total}
          </span>
          <button
            className="icon"
            aria-label="Previous clip"
            disabled={index === 0 || pending}
            onClick={() => onNext(-1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button
            className="icon"
            aria-label="Next clip"
            disabled={index === total - 1 || pending}
            onClick={() => onNext(1)}
          >
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
      <div className="review-heading">
        <div>
          <p className="eyebrow copper">
            {s.speaker}{" "}
            <span>
              · {duration(r.durationMs)} · VERSION {r.version}
            </span>
          </p>
          <h1>{clip.title}</h1>
        </div>
        <div className="review-badges">
          <span className="pill">
            {productionLabel(clip.production)}
          </span>
          <span className="pill amber">
            Airing:{" "}
            {clip.airing.state === "unknown" ? "unverified" : clip.airing.state}
          </span>
        </div>
      </div>
      <div className="review-grid">
        <section className="media-column" aria-label="Clip player and review">
          <div className="player-shell">
            {r.mediaAvailable ? (
              <div
                className={`video-stage${mediaError ? " has-media-error" : ""}`}
              >
                <video
                  ref={video}
                  controls={!mediaError}
                  aria-hidden={!!mediaError}
                  tabIndex={mediaError ? -1 : 0}
                  onLoadedMetadata={() => {
                    setMediaReady(true);
                    setMediaError("");
                  }}
                  preload="metadata"
                  playsInline
                  onKeyDown={playerKeys}
                  onTimeUpdate={() =>
                    setElapsed((video.current?.currentTime || 0) * 1000)
                  }
                  onError={() => {
                    video.current?.pause();
                    setMediaReady(false);
                    setMediaError(
                      "Access may have expired, or the file may be unavailable. Your note is kept.",
                    );
                  }}
                  src={`/media/${encodeURIComponent(r.id)}/${r.proxyAvailable ? "proxy" : "original"}`}
                  aria-label={`${clip.title}, version ${r.version}`}
                >
                  {captions && (
                    <track
                      kind="captions"
                      label="English transcript"
                      srcLang="en"
                      src={captions}
                    />
                  )}
                </video>
                {mediaError && (
                  <div className="playback-failure" role="alert">
                    <span className="film-circle">
                      <TriangleAlert size={25} />
                    </span>
                    <h2>Playback unavailable</h2>
                    <p>{mediaError}</p>
                    <div className="playback-recovery">
                      <button
                        onClick={() => {
                          setMediaError("");
                          setMediaReady(false);
                          video.current?.load();
                        }}
                      >
                        <RefreshCw size={15} />
                        Retry playback
                      </button>
                      {r.driveUrl && (
                        <a
                          className="button"
                          href={r.driveUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <ExternalLink size={15} />
                          Open in Drive
                        </a>
                      )}
                    </div>
                    <small>No playback check has been completed.</small>
                  </div>
                )}
              </div>
            ) : (
              <div className="missing-media">
                {demo && (
                  <img
                    src={thumbnail(clip)}
                    alt={`Fictional waveform illustration for ${s.speaker}; video is not connected`}
                  />
                )}
                <div className="media-shade" />
                <div className="missing-message">
                  <span className="film-circle">
                    <Film size={26} />
                  </span>
                  <h2>
                    {demo ? "Your review starts here" : "Media unavailable"}
                  </h2>
                  <p>
                    {demo
                      ? "Sample artwork · private video is not connected."
                      : "No authorized playable artifact is available for this render."}
                  </p>
                  <span className="media-label">
                    {demo
                      ? "LOCAL DEMO · NO VIDEO LOADED"
                      : "CHECK SOURCE ACCESS"}
                  </span>
                </div>
              </div>
            )}
            <div className="player-meta">
              <span>
                <Headphones size={15} />
                {mediaError
                  ? "Playback unavailable"
                  : r.mediaAvailable
                    ? `${duration(elapsed)} / ${duration(r.durationMs)}`
                    : "Playback check pending"}
              </span>
              <span>
                {r.mediaAvailable
                  ? "Native player · no autoplay"
                  : "Fictional sample artwork"}
                <span className="tiny-dot" />v{r.version}
              </span>
            </div>
          </div>
          <div className="boundaries">
            <div>
              <span>SOURCE IN</span>
              <strong>
                {r.mappingVerified ? timecode(s.inMs) : "Mapping unverified"}
              </strong>
            </div>
            <div>
              <span>SOURCE OUT</span>
              <strong>
                {r.mappingVerified ? timecode(s.outMs) : "Mapping unverified"}
              </strong>
            </div>
            <div>
              <span>RENDER DURATION</span>
              <strong>{timecode(r.durationMs)}</strong>
            </div>
          </div>
          <section className="decision-panel">
            <div className="decision-title">
              <div>
                <h2>Your editorial decision</h2>
                <p>For this version. Approval does not mean aired.</p>
              </div>
              <span className={`decision-pill ${r.review.decision}`}>
                {labels[r.review.decision]}
              </span>
            </div>
            <div className="decision-buttons">
              <button
                className="approve"
                disabled={pending}
                aria-pressed={r.review.decision === "up"}
                onClick={() => onDecide(clip, "up", note, reason)}
              >
                <ThumbsUp size={17} />
                Approve{shortcuts && <kbd>Alt A</kbd>}
              </button>
              <button
                disabled={pending}
                aria-pressed={r.review.decision === "down"}
                onClick={() => onDecide(clip, "down", note, reason)}
              >
                <ThumbsDown size={17} />
                Reject
              </button>
              <button
                disabled={pending}
                aria-pressed={r.review.decision === "defer"}
                onClick={() => onDecide(clip, "defer", note, reason)}
              >
                <Clock3 size={17} />
                Defer
              </button>
              <button
                className="quiet"
                disabled={pending || r.review.decision === "clear"}
                onClick={() => onDecide(clip, "clear", note, reason)}
              >
                Clear
              </button>
            </div>
            <label className="note-label" htmlFor="review-note">
              Add context <span>optional</span>
            </label>
            <textarea
              id="review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={4000}
              aria-describedby="draft-hint"
              placeholder="What works? What needs another pass?"
            />
            <p id="draft-hint" className="draft-hint">
              Unsaved notes are kept for this render in this browser tab.
            </p>
            <div className="reason-row">
              <label>
                Reason
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                >
                  <option value="">No reason selected</option>
                  {[
                    "Strong opener",
                    "Needs context",
                    "Duplicate angle",
                    "Source too old",
                    "Audio problem",
                    "Wrong angle",
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <button
                disabled={
                  pending ||
                  (note === r.review.note && reason === r.review.reason)
                }
                onClick={() => onDecide(clip, r.review.decision, note, reason)}
              >
                {pending ? "Saving…" : "Save note"}
              </button>
            </div>
            <p className="save-meta" role="status">
              {pending
                ? "Saving, please wait…"
                : r.review.updatedAt
                  ? `${demo ? "Demo update" : "Saved"} ${new Date(r.review.updatedAt).toLocaleTimeString()} · revision ${r.review.revision}`
                  : "No decision recorded for this version."}
            </p>
          </section>
          <div className="download-row">
            {r.mediaAvailable ? (
              <>
                {r.proxyAvailable && (
                  <a
                    className="button"
                    href={`/media/${encodeURIComponent(r.id)}/proxy?download=1`}
                    download
                  >
                    <Download size={16} />
                    Compact preview
                  </a>
                )}
                <a
                  className="button"
                  href={`/media/${encodeURIComponent(r.id)}/original?download=1`}
                  download
                >
                  <Download size={16} />
                  Full quality
                </a>
              </>
            ) : (
              <span className="muted">
                <Download size={15} />
                Downloads available when private media is connected.
              </span>
            )}
          </div>
        </section>
        <aside className="context-column">
          <section className="context-panel">
            <div className="context-heading">
              <h2>Source & context</h2>
              <span className="version">v{r.version}</span>
            </div>
            <p className="source-title">
              {s.title} <span>· {s.speaker}</span>
            </p>
            <p className="source-subtitle">
              Published {date(s.publicationDate)}
            </p>
            <div className="context-tabs">
              <button
                className={context === "transcript" ? "selected" : ""}
                onClick={() => setContext("transcript")}
              >
                Transcript
              </button>
              <button
                className={context === "evidence" ? "selected" : ""}
                onClick={() => setContext("evidence")}
              >
                QA evidence
              </button>
            </div>
            {context === "transcript" ? (
              <div className="transcript">
                {r.cues.length ? (
                  r.cues.map((cue) => (
                    <button
                      key={cue.id}
                      disabled={
                        !canSeekMedia(
                          r.mappingVerified,
                          r.mediaAvailable,
                          mediaReady,
                          mediaError,
                        )
                      }
                      onClick={() => {
                        if (
                          video.current &&
                          canSeekMedia(
                            r.mappingVerified,
                            r.mediaAvailable,
                            mediaReady,
                            mediaError,
                          )
                        )
                          video.current.currentTime = Math.max(
                            0,
                            cue.startMs / 1000,
                          );
                      }}
                    >
                      <span>
                        Clip {timecode(cue.startMs)} · source{" "}
                        {timecode(s.inMs + cue.startMs)}
                      </span>
                      <p>{cue.text}</p>
                    </button>
                  ))
                ) : (
                  <div className="transcript-empty">
                    <Headphones size={25} />
                    <h3>No timed transcript yet</h3>
                    <p>
                      A verified, render-aligned transcript will appear here
                      when imported. No transcript has been imported for this
                      render.
                    </p>
                  </div>
                )}
                {!r.mappingVerified && (
                  <p className="inline-warning">
                    <TriangleAlert size={14} />
                    Source-to-render mapping unverified. Transcript seeking is
                    unavailable.
                  </p>
                )}
              </div>
            ) : (
              <div className="qa-list">
                {r.qa.map((q, i) => (
                  <div key={i}>
                    <strong>{q.check}</strong>
                    <span
                      className={q.result === "passed" ? "copper" : "muted"}
                    >
                      {q.result === "unknown" ? "Pending" : q.result}
                    </span>
                    <p>{q.method}</p>
                    <small>
                      {q.checkedAt
                        ? date(q.checkedAt)
                        : "No completed check recorded"}
                    </small>
                  </div>
                ))}
              </div>
            )}
            <div className="context-note">
              <span className="eyebrow copper">WHY THIS CLIP</span>
              <p>{clip.summary || s.context}</p>
              <small>Suggested editorial context</small>
            </div>
          </section>
          <dl className="source-facts">
            <div>
              <dt>RECORDED DATE</dt>
              <dd>{date(s.recordingDate)}</dd>
            </div>
            <div>
              <dt>PUBLISHED DATE</dt>
              <dd>{date(s.publicationDate)}</dd>
            </div>
            <div>
              <dt>LAST REAL PROGRESS</dt>
              <dd>
                {clip.production.lastProgressAt
                  ? date(clip.production.lastProgressAt)
                  : "Unknown · no producer event"}
              </dd>
            </div>
            <div>
              <dt>NEXT EXPECTED UPDATE</dt>
              <dd>
                {clip.production.nextExpectedAt
                  ? new Date(clip.production.nextExpectedAt).toLocaleString()
                  : "Not supplied"}
              </dd>
            </div>
          </dl>
          {(clip.production.stale || clip.production.blocker) && (
            <div className="progress-warning">
              <Clock3 size={16} />
              <p>
                {clip.production.blocker ||
                  "No recent update; producer status unknown."}
              </p>
            </div>
          )}
          <div className="source-actions">
            {r.driveUrl && (
              <a
                className="quiet"
                href={r.driveUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open in Drive
                <ExternalLink size={14} />
              </a>
            )}
            {s.url && (
              <a
                className="quiet"
                href={s.url}
                target="_blank"
                rel="noreferrer"
              >
                Open original source
                <ExternalLink size={14} />
              </a>
            )}
            <button
              className="quiet"
              disabled={pending}
              onClick={() => onVisibility(clip)}
            >
              {clip.visibility === "hidden" ? (
                <Eye size={15} />
              ) : (
                <EyeOff size={15} />
              )}{" "}
              {clip.visibility === "hidden"
                ? "Restore to slate"
                : "Hide from slate"}
            </button>
            <p>
              Hidden clips can be restored. Originals are retained.
              <br />
              Manage original files in Drive.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
