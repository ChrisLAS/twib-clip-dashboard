import type { CatalogStatus, EpisodeDetail } from "@twib/shared";

export interface CatalogUpdates {
  available: boolean;
  newClips: number | null;
  changedClips: number | null;
}

/** Count only a complete, comparable snapshot. Missing data never means zero. */
export function catalogUpdates(
  episode: EpisodeDetail | null,
  status: CatalogStatus | null,
): CatalogUpdates {
  const unknown = { available: true, newClips: null, changedClips: null };
  const none = { available: false, newClips: 0, changedClips: 0 };
  if (!status) return { available: false, newClips: null, changedClips: null };
  if (!episode) {
    return status.clips.length || status.complete !== true ? unknown : none;
  }
  // The status request may have started before a newer slate was loaded.
  if (
    Number.isInteger(episode.catalogVersion) &&
    status.version <= episode.catalogVersion
  )
    return none;
  if (
    status.complete !== true ||
    !Number.isInteger(episode.catalogVersion) ||
    episode.clips.some((clip) => !Number.isInteger(clip.catalogRevision))
  )
    return unknown;
  const loaded = new Map(episode.clips.map((clip) => [clip.id, clip]));
  const current = status.clips.filter((clip) => clip.episodeId === episode.id);
  const ids = new Set(current.map((clip) => clip.id));
  if (
    ids.size !== current.length ||
    episode.clips.some((clip) => !ids.has(clip.id))
  )
    return unknown;
  let newClips = 0;
  let changedClips = 0;
  for (const clip of current) {
    if (!Number.isInteger(clip.revision)) return unknown;
    const previous = loaded.get(clip.id);
    if (!previous) newClips++;
    else if (
      clip.revision > previous.catalogRevision ||
      clip.currentRenderId !== previous.currentRenderId
    )
      changedClips++;
  }
  // A global version change can include another episode or episode metadata.
  if (!newClips && !changedClips) return unknown;
  return { available: true, newClips, changedClips };
}

export function catalogUpdateLabel(updates: CatalogUpdates): string {
  if (updates.newClips === null || updates.changedClips === null)
    return "Catalog updates available";
  const parts = [];
  if (updates.newClips)
    parts.push(
      `${updates.newClips} new clip${updates.newClips === 1 ? "" : "s"}`,
    );
  if (updates.changedClips)
    parts.push(
      `${updates.changedClips} changed clip${updates.changedClips === 1 ? "" : "s"}`,
    );
  return `${parts.join(" and ")} available`;
}

/** A later fetch cannot roll back a save already reflected in this tab. */
export function preserveNewerReviews(
  previous: EpisodeDetail | null,
  incoming: EpisodeDetail,
): EpisodeDetail {
  if (!previous || previous.id !== incoming.id) return incoming;
  const clips = new Map(previous.clips.map((clip) => [clip.id, clip]));
  return {
    ...incoming,
    clips: incoming.clips.map((clip) => {
      const before = clips.get(clip.id);
      if (!before) return clip;
      const keepReview =
        before.render.id === clip.render.id &&
        before.render.review.revision > clip.render.review.revision;
      const keepVisibility =
        before.visibilityRevision > clip.visibilityRevision;
      return {
        ...clip,
        ...(keepReview
          ? { render: { ...clip.render, review: before.render.review } }
          : {}),
        ...(keepVisibility
          ? {
              visibility: before.visibility,
              visibilityRevision: before.visibilityRevision,
            }
          : {}),
      };
    }),
  };
}

/** Owns one deliberate slate fetch; cancel/navigation invalidates all its results. */
export class SlateRequestGate {
  private active: AbortController | null = null;
  private latest: AbortController | null = null;
  begin(): AbortController | null {
    if (this.active) return null;
    const controller = new AbortController();
    this.active = controller;
    this.latest = controller;
    return controller;
  }
  isCurrent(controller: AbortController): boolean {
    return this.active === controller && this.isLatest(controller);
  }
  /** Also guards React updates queued just before a navigation or new fetch. */
  isLatest(controller: AbortController): boolean {
    return this.latest === controller && !controller.signal.aborted;
  }
  finish(controller: AbortController): boolean {
    if (!this.isCurrent(controller)) return false;
    this.active = null;
    return true;
  }
  cancel(): void {
    this.latest?.abort();
    this.latest = null;
    this.active = null;
  }
}

/** Stored status only: never imports or requests Google from the browser. */
export function startVisibleCatalogPolling({
  read,
  onStatus,
  onError,
  visibility,
  intervalMs = 30_000,
}: {
  read: (signal: AbortSignal) => Promise<CatalogStatus>;
  onStatus: (status: CatalogStatus) => void;
  onError: (message: string) => void;
  visibility: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  >;
  intervalMs?: number;
}): () => void {
  let stopped = false;
  let inFlight: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const poll = async () => {
    if (stopped || visibility.visibilityState !== "visible" || inFlight) return;
    const controller = new AbortController();
    inFlight = controller;
    try {
      const status = await read(controller.signal);
      if (!stopped && !controller.signal.aborted) onStatus(status);
    } catch (error) {
      if (!stopped && !controller.signal.aborted)
        onError(error instanceof Error ? error.message : "Status check failed");
    } finally {
      if (inFlight === controller) {
        inFlight = null;
        if (!stopped && visibility.visibilityState === "visible")
          timer = setTimeout(() => void poll(), intervalMs);
      }
    }
  };
  const changed = () => {
    clear();
    if (visibility.visibilityState !== "visible") {
      inFlight?.abort();
      inFlight = null;
    } else void poll();
  };
  visibility.addEventListener("visibilitychange", changed);
  void poll();
  return () => {
    stopped = true;
    clear();
    inFlight?.abort();
    inFlight = null;
    visibility.removeEventListener("visibilitychange", changed);
  };
}
