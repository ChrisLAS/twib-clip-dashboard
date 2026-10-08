import { PublicationPanel } from "./publication-panel";
import { EditorialPanel } from "./editorial-panel";
import { AiringPanel } from "./airing-panel";
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
  Episode,
  EpisodeDetail,
  IntakeMutationResult,
  ManualIntake,
  Review,
  Session,
} from "@twib/shared";
import { api, date, duration, RequestError, timecode } from "./api";
import { demoEpisode, thumbnail } from "./demo";
import "./style.css";
import { canSeekMedia, productionLabel } from "./review-state";
import { readDraft, storeDraft } from "./drafts";
import { ImportControl } from "./import-control";
import { ClipThumbnail } from "./clip-thumbnail";
import { CatalogSyncNotice } from "./catalog-sync-notice";
import { preserveNewerReviews, SlateRequestGate } from "./catalog-sync";
import {
  chooseEpisode,
  episodeUrl,
  requestedEpisode,
} from "./episode-selection";
import { ManualIntakePanel } from "./manual-intake";
import { pendingIntakes, preserveIntakes } from "./intake-state";
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
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodeId, setEpisodeId] = useState<string | null>(() =>
    requestedEpisode(location.href),
  );
  const episodeIdRef = useRef(episodeId);
  const [intakes, setIntakes] = useState<ManualIntake[]>([]);
  const [intakeVersion, setIntakeVersion] = useState(0);
  const intakeVersionRef = useRef(0);
  const openingRender = useRef<{ episodeId: string; renderId: string } | null>(
    null,
  );
  const openingHistory = useRef<{
    episodeId: string;
    clipId: string;
    renderId?: string;
  } | null>(null);
  const loadRef = useRef<(id?: string | null) => Promise<void>>(async () => {});
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
  const [slateRevision, setSlateRevision] = useState(0);
  const mutationLock = useRef(false);
  const slateRequests = useRef(new SlateRequestGate());
  const selectedRef = useRef(selected);
  const episodeRef = useRef(episode);
  episodeRef.current = episode;
  const drafts = useRef(new Map<string, { note: string; reason: string }>());
  const scroll = useRef(0),
    openButton = useRef<HTMLElement | null>(null);
  const demo = isLocalDemo || session?.mode === "demo";
  function cancelLoad() {
    slateRequests.current.cancel();
    setLoading(false);
  }
  async function load(requestedId = episodeIdRef.current) {
    // A catalog refresh never swaps the render underneath an active review.
    if (selectedRef.current || mutationLock.current) return;
    const controller = slateRequests.current.begin();
    if (!controller) return;
    const canApply = () =>
      slateRequests.current.isLatest(controller) &&
      !selectedRef.current &&
      !mutationLock.current;
    const isCurrent = () =>
      slateRequests.current.isCurrent(controller) && canApply();
    setLoading(true);
    setError("");
    try {
      if (isLocalDemo) {
        if (!isCurrent()) return;
        const next = structuredClone(demoEpisode);
        episodeIdRef.current = next.id;
        setEpisodeId(next.id);
        setEpisodes([next]);
        setEpisode((previous) => (canApply() ? (previous ?? next) : previous));
        setSession((previous) =>
          canApply()
            ? {
                csrfToken: "",
                mode: "demo",
                owner: "Local reviewer",
                integrations: { drive: false, producer: false },
              }
            : previous,
        );
      } else {
        const s = await api.session(controller.signal);
        if (!isCurrent()) return;
        setSession((previous) => (canApply() ? s : previous));
        const eps = await api.episodes(controller.signal);
        if (!isCurrent()) return;
        setEpisodes((previous) => (canApply() ? eps : previous));
        const choice = chooseEpisode(eps, requestedId);
        episodeIdRef.current = choice?.id ?? null;
        setEpisodeId(choice?.id ?? null);
        const [next, intake] = await Promise.all([
          choice
            ? api.episode(choice.id, controller.signal)
            : Promise.resolve(null),
          api.intakes(controller.signal),
        ]);
        if (!isCurrent() || (next && next.id !== choice?.id)) return;
        setEpisode((previous) =>
          canApply()
            ? next
              ? preserveNewerReviews(previous, next)
              : null
            : previous,
        );
        if (intake.version >= intakeVersionRef.current) {
          intakeVersionRef.current = intake.version;
          setIntakeVersion((previous) =>
            canApply() ? intake.version : previous,
          );
          setIntakes((previous) =>
            canApply() ? preserveIntakes(previous, intake.items) : previous,
          );
        }
        if (choice && openingHistory.current?.episodeId !== choice.id)
          history.replaceState(
            { episodeId: choice.id },
            "",
            episodeUrl(location.href, choice.id),
          );
        if (requestedId && choice?.id !== requestedId)
          setNotice(
            "That episode is unavailable. Showing the active workspace instead.",
          );
      }
      setSlateRevision((revision) => (canApply() ? revision + 1 : revision));
    } catch (e) {
      if (isCurrent())
        setError(e instanceof Error ? e.message : "Unable to load the slate");
    } finally {
      if (slateRequests.current.finish(controller)) setLoading(false);
    }
  }
  loadRef.current = load;
  function changeEpisode(
    id: string,
    writeHistory = true,
    preserveRenderIntent = false,
  ) {
    if (mutationLock.current) return;
    if (!preserveRenderIntent) openingRender.current = null;
    openingHistory.current = null;
    cancelLoad();
    selectedRef.current = null;
    setSelected(null);
    episodeIdRef.current = id;
    setEpisodeId(id);
    setEpisode(null);
    setUndo(null);
    setNotice("");
    setSaveError("");
    setFilter("All clips");
    setQuery("");
    if (writeHistory)
      history.pushState({ episodeId: id }, "", episodeUrl(location.href, id));
    void loadRef.current(id);
  }
  function intakeSaved(result: IntakeMutationResult) {
    intakeVersionRef.current = Math.max(
      intakeVersionRef.current,
      result.intakeVersion,
    );
    setIntakeVersion(intakeVersionRef.current);
    setIntakes((previous) => [
      result.intake,
      ...previous.filter((item) => item.id !== result.intake.id),
    ]);
  }
  function openExistingRender(targetEpisode: string, renderId: string) {
    const existing = episodeRef.current;
    if (existing?.id === targetEpisode) {
      const target = existing.clips.find((item) => item.render.id === renderId);
      if (target) open(target);
      else
        setNotice(
          "That source matches an older render. This slate shows current versions only; the matched historical render was not opened.",
        );
    } else {
      openingRender.current = { episodeId: targetEpisode, renderId };
      changeEpisode(targetEpisode, true, true);
    }
  }
  useEffect(() => {
    if (!episode || loading) return;
    const restored = openingHistory.current;
    if (restored?.episodeId === episode.id) {
      openingHistory.current = null;
      const target = episode.clips.find(
        (item) =>
          item.id === restored.clipId &&
          (!restored.renderId || item.render.id === restored.renderId),
      );
      if (target) {
        selectedRef.current = target.id;
        setSelected(target.id);
        setSaveError("");
        history.replaceState(
          {
            episodeId: episode.id,
            clipId: target.id,
            renderId: target.render.id,
          },
          "",
          episodeUrl(location.href, episode.id, target.id),
        );
        window.scrollTo(0, 0);
      } else {
        history.replaceState(
          { episodeId: episode.id },
          "",
          episodeUrl(location.href, episode.id),
        );
        setNotice(
          "That exact review version is no longer current. Your render-specific draft is kept; choose a clip to review its current version.",
        );
      }
      return;
    }
    const requested = openingRender.current;
    if (!requested || episode.id !== requested.episodeId) return;
    openingRender.current = null;
    const target = episode.clips.find(
      (item) => item.render.id === requested.renderId,
    );
    if (target) open(target);
    else
      setNotice(
        "That source matches an older render. This slate shows current versions only; the matched historical render was not opened.",
      );
  }, [episode, loading]);
  useEffect(() => {
    void load();
    return () => slateRequests.current.cancel();
  }, []);
  useEffect(() => {
    const fn = () => {
      if (mutationLock.current) {
        if (episodeIdRef.current)
          history.replaceState(
            {
              episodeId: episodeIdRef.current,
              clipId: selectedRef.current,
              renderId: episodeRef.current?.clips.find(
                (item) => item.id === selectedRef.current,
              )?.render.id,
            },
            "",
            episodeUrl(
              location.href,
              episodeIdRef.current,
              selectedRef.current ?? undefined,
            ),
          );
        return;
      }
      cancelLoad();
      openingRender.current = null;
      openingHistory.current = null;
      const requestedId =
        requestedEpisode(location.href) ?? history.state?.episodeId;
      if (
        requestedId &&
        (requestedId !== episodeIdRef.current || !episodeRef.current)
      ) {
        if (history.state?.clipId)
          openingHistory.current = {
            episodeId: requestedId,
            clipId: history.state.clipId,
            renderId: history.state.renderId,
          };
        selectedRef.current = null;
        setSelected(null);
        episodeIdRef.current = requestedId;
        setEpisodeId(requestedId);
        setEpisode(null);
        setUndo(null);
        setNotice("");
        setSaveError("");
        void loadRef.current(requestedId);
        return;
      }
      const requested = history.state?.clipId;
      const id = episodeRef.current?.clips.some(
        (clip) =>
          clip.id === requested &&
          (!history.state?.renderId ||
            clip.render.id === history.state.renderId),
      )
        ? (requested as string)
        : null;
      selectedRef.current = id;
      setSelected(id);
      setSaveError("");
      if (!id)
        requestAnimationFrame(() => {
          if (!selectedRef.current) window.scrollTo(0, scroll.current);
        });
    };
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  function open(clip: Clip) {
    if (mutationLock.current) return;
    openingRender.current = null;
    openingHistory.current = null;
    cancelLoad();
    if (!selectedRef.current) {
      scroll.current = window.scrollY;
      openButton.current = document.activeElement as HTMLElement;
    }
    selectedRef.current = clip.id;
    setSelected(clip.id);
    setSaveError("");
    history.pushState(
      { episodeId: clip.episodeId, clipId: clip.id, renderId: clip.render.id },
      "",
      episodeUrl(location.href, clip.episodeId, clip.id),
    );
    window.scrollTo(0, 0);
  }
  function back() {
    if (mutationLock.current) return;
    openingRender.current = null;
    openingHistory.current = null;
    cancelLoad();
    selectedRef.current = null;
    setSelected(null);
    if (episodeIdRef.current)
      history.replaceState(
        { episodeId: episodeIdRef.current },
        "",
        episodeUrl(location.href, episodeIdRef.current),
      );
    requestAnimationFrame(() => {
      if (selectedRef.current) return;
      window.scrollTo(0, scroll.current);
      openButton.current?.focus();
    });
  }
  function update(id: string, fn: (c: Clip) => Clip) {
    setEpisode((prev) =>
      prev && prev.id === episodeIdRef.current
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
    cancelLoad();
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
    cancelLoad();
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
        {!clip && episodes.length > 0 && (
          <div className="workspace-picker">
            <label htmlFor="episode-picker">Episode</label>
            <select
              id="episode-picker"
              value={episodeId ?? ""}
              disabled={pending}
              onChange={(event) => changeEpisode(event.target.value)}
            >
              {episodes.map((item) => (
                <option key={item.id} value={item.id}>
                  Episode {item.number} ·{" "}
                  {item.status ?? (item.publishedGuid ? "published" : "draft")}
                  {item.isActive ? " · active" : ""}
                </option>
              ))}
            </select>
            <span className="muted">
              {episode?.isActive
                ? "Active workspace"
                : episode?.status === "published" || episode?.publishedGuid
                  ? "Published episode"
                  : "Episode workspace"}
            </span>
          </div>
        )}
        {!demo && session && (
          <>
            <CatalogSyncNotice
              key={episodeId ?? "empty"}
              episode={episode}
              intakeVersion={intakeVersion}
              reviewing={!!clip}
              loading={loading}
              pending={pending}
              onApply={() => void load()}
              onCancel={() => {
                openingRender.current = null;
                openingHistory.current = null;
                cancelLoad();
              }}
              onBack={back}
            />
            <details className="sync-troubleshooting" hidden={!!clip}>
              <summary>Troubleshooting</summary>
              <p>
                Automatic sync checks the server-configured catalog. Use a
                manual import only to troubleshoot a delayed sync.
              </p>
              <ImportControl
                csrf={session.csrfToken}
                ready={
                  session.integrations.drive && session.integrations.producer
                }
                hidden={!!clip}
                hasClips={!!episode?.clips.length}
                slateRevision={slateRevision}
                onRefresh={() => void load()}
                refreshDisabled={pending || loading}
              />
            </details>
          </>
        )}
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
            <button
              onClick={() => void load()}
              disabled={loading || pending || !!clip}
            >
              Try again
            </button>
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
            <h1>
              {episodes.length ? "Episode not loaded" : "No episodes yet"}
            </h1>
            <p>
              Clips will appear after an authorized producer manifest is
              imported.
            </p>
            <button onClick={() => void load()} disabled={loading || pending}>
              Refresh
            </button>
          </div>
        ) : (
          episode && (
            <>
              {!clip && (
                <PublicationPanel
                  csrf={session?.csrfToken ?? ""}
                  demo={!!demo}
                />
              )}
              <EditorialPanel
                key={`editorial-${episode.id}-${clip?.render.id ?? "slate"}`}
                csrf={session?.csrfToken ?? ""}
                episodeId={episode.id}
                renderId={clip?.render.id}
                demo={!!demo}
              />
              {clip && (
                <AiringPanel
                  key={`airing-${clip.render.id}`}
                  csrf={session?.csrfToken ?? ""}
                  renderId={clip.render.id}
                  demo={!!demo}
                />
              )}
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
                        onClick={() => void load()}
                        disabled={loading || pending}
                      >
                        <RefreshCw
                          size={14}
                          className={loading ? "spin" : ""}
                        />
                        {loading ? "Refreshing…" : "Refresh slate"}
                      </button>
                      {demo && loading && (
                        <button className="quiet" onClick={cancelLoad}>
                          Cancel refresh
                        </button>
                      )}
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
                      <span>imported renders</span>
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
                    <div>
                      <strong>
                        {pendingIntakes(intakes, episode.id).length}
                      </strong>
                      <span>pending intake</span>
                    </div>
                    <div>
                      <strong>
                        {
                          episode.clips.filter(
                            (item) =>
                              item.production.state === "ready" &&
                              !item.production.blocker &&
                              !item.production.stale &&
                              item.render.mediaAvailable,
                          ).length
                        }
                      </strong>
                      <span>ready for review</span>
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
                            ? "Latest applied slate · new updates appear above"
                            : demo
                              ? "No live integration · producer status unknown"
                              : "Waiting for a successful catalog sync"}
                        </small>
                      </span>
                    </div>
                  </section>
                  <ManualIntakePanel
                    episodes={episodes}
                    episodeId={episode.id}
                    items={intakes}
                    csrf={session?.csrfToken ?? ""}
                    demo={!!demo}
                    hidden={false}
                    disabled={pending}
                    onBusy={(busy) => {
                      if (busy) cancelLoad();
                      mutationLock.current = busy;
                      setPending(busy);
                    }}
                    onSaved={intakeSaved}
                    onOpenRender={openExistingRender}
                  />
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
                            <ClipThumbnail
                              key={`${c.render.id}:${slateRevision}`}
                              renderId={c.render.id}
                              available={c.render.mediaAvailable}
                            />
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
                          : "No reviewable clips yet"}
                      </h2>
                      <p>
                        {episode.clips.length
                          ? "Try another search or clear your filters."
                          : "Saved manual submissions appear above. Reviewable clips will appear here after a verified render is imported."}
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
                  <button
                    disabled={pending || loading}
                    onClick={clip ? back : () => void load()}
                  >
                    {clip ? "Back to slate to refresh" : "Refresh slate"}
                  </button>
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
          <span className="pill">{productionLabel(clip.production)}</span>
          <span className="pill amber">
            Airing: {demo ? "unverified" : "see owner verification"}
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
