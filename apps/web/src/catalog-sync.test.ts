import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogStatus } from "@twib/shared";
import { api } from "./api";
import { demoEpisode } from "./demo";
import {
  catalogUpdateLabel,
  catalogUpdates,
  preserveNewerReviews,
  SlateRequestGate,
  startVisibleCatalogPolling,
} from "./catalog-sync";

function fixture() {
  const episode = structuredClone(demoEpisode);
  episode.catalogVersion = 2;
  episode.clips = episode.clips.slice(0, 2);
  episode.clips.forEach((clip) => {
    clip.catalogRevision = 2;
  });
  const status: CatalogStatus = {
    version: 2,
    observedAt: "2026-10-08T00:00:00Z",
    complete: true,
    sync: {
      configured: true,
      running: false,
      lastAttemptAt: "2026-10-08T00:00:00Z",
      lastSuccessAt: "2026-10-08T00:00:00Z",
      lastError: null,
      stale: false,
      intervalSeconds: 300,
    },
    clips: episode.clips.map((clip) => ({
      id: clip.id,
      episodeId: clip.episodeId,
      revision: clip.catalogRevision,
      currentRenderId: clip.currentRenderId,
    })),
  };
  return { episode, status };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("catalog update counts", () => {
  it("does not create notices for unchanged repeated checks or review-only saves", () => {
    const { episode, status } = fixture();
    episode.clips[0].render.review.revision++;
    episode.clips[0].visibilityRevision++;
    for (let check = 0; check < 3; check++)
      expect(catalogUpdates(episode, status)).toEqual({
        available: false,
        newClips: 0,
        changedClips: 0,
      });
  });
  it("counts new and changed clip identities rather than renders or polling attempts", () => {
    const { episode, status } = fixture();
    status.version++;
    status.clips[0].revision++;
    status.clips[0].currentRenderId = "new-render";
    status.clips.push({
      id: "new-clip",
      episodeId: episode.id,
      revision: 1,
      currentRenderId: "new-clip-v1",
    });
    const updates = { available: true, newClips: 1, changedClips: 1 };
    expect(catalogUpdates(episode, status)).toEqual(updates);
    expect(catalogUpdates(episode, status)).toEqual(updates);
    expect(catalogUpdateLabel(updates)).toBe(
      "1 new clip and 1 changed clip available",
    );
  });
  it("detects producer metadata changes even when the current render stays the same", () => {
    const { episode, status } = fixture();
    status.version++;
    status.clips[1].revision++;
    expect(catalogUpdates(episode, status)).toEqual({
      available: true,
      newClips: 0,
      changedClips: 1,
    });
  });
  it("ignores a status result older than the deliberately applied slate", () => {
    const { episode, status } = fixture();
    episode.catalogVersion++;
    status.clips.push({
      id: "old-index",
      episodeId: episode.id,
      revision: 1,
      currentRenderId: "old-render",
    });
    expect(catalogUpdates(episode, status).available).toBe(false);
  });
  it.each([
    "partial",
    "missing-revision",
    "missing-clip",
    "duplicate",
    "other-episode",
  ])(
    "uses an uncounted notice for %s snapshots instead of guessing",
    (kind) => {
      const { episode, status } = fixture();
      status.version++;
      if (kind === "partial") status.complete = false;
      if (kind === "missing-revision")
        delete (episode.clips[0] as Partial<(typeof episode.clips)[0]>)
          .catalogRevision;
      if (kind === "missing-clip") status.clips.pop();
      if (kind === "duplicate") status.clips.push(status.clips[0]);
      if (kind === "other-episode")
        status.clips.push({
          id: "other",
          episodeId: "other-episode",
          revision: 1,
          currentRenderId: "other-render",
        });
      const updates = catalogUpdates(episode, status);
      expect(updates).toEqual({
        available: true,
        newClips: null,
        changedClips: null,
      });
      expect(catalogUpdateLabel(updates)).toBe("Catalog updates available");
    },
  );
  it("does not treat an incomplete empty index as proof of no updates", () => {
    const { status } = fixture();
    status.clips = [];
    status.complete = false;
    expect(catalogUpdates(null, status)).toEqual({
      available: true,
      newClips: null,
      changedClips: null,
    });
  });
  it("notices the first imported slate without inventing clip counts", () => {
    const { status } = fixture();
    expect(catalogUpdates(null, status)).toEqual({
      available: true,
      newClips: null,
      changedClips: null,
    });
    expect(catalogUpdates(null, null).available).toBe(false);
  });
});

describe("slate update safety", () => {
  it("deduplicates pending clicks and ignores cancelled responses even after a new request starts", () => {
    const gate = new SlateRequestGate();
    const old = gate.begin()!;
    expect(gate.begin()).toBeNull();
    gate.cancel();
    expect(old.signal.aborted).toBe(true);
    const current = gate.begin()!;
    expect(gate.finish(old)).toBe(false);
    expect(gate.isCurrent(current)).toBe(true);
    expect(gate.isCurrent(old)).toBe(false);
    expect(gate.finish(current)).toBe(true);
    expect(gate.begin()).not.toBeNull();
  });
  it("invalidates a completed result queued before navigation or a newer fetch", () => {
    const gate = new SlateRequestGate();
    const completed = gate.begin()!;
    gate.finish(completed);
    expect(gate.isLatest(completed)).toBe(true);
    gate.cancel();
    expect(gate.isLatest(completed)).toBe(false);
    const next = gate.begin()!;
    gate.finish(next);
    gate.begin();
    expect(gate.isLatest(next)).toBe(false);
  });
  it("preserves newer locally saved review and visibility revisions over stale reads", () => {
    const { episode } = fixture();
    const previous = structuredClone(episode);
    previous.clips[0].render.review = {
      decision: "up",
      note: "Saved note",
      reason: "Strong opener",
      revision: 3,
      updatedAt: "2026-10-08T00:00:00Z",
    };
    previous.clips[0].visibility = "hidden";
    previous.clips[0].visibilityRevision = 2;
    const merged = preserveNewerReviews(previous, episode);
    expect(merged.clips[0].render.review).toEqual(
      previous.clips[0].render.review,
    );
    expect(merged.clips[0].visibility).toBe("hidden");
    expect(episode.clips[0].render.review.revision).toBe(0);
  });
  it("does not copy a previous render's decision onto a new render", () => {
    const { episode } = fixture();
    const previous = structuredClone(episode);
    previous.clips[0].render.review.revision = 8;
    previous.clips[0].render.review.note = "Old render only";
    episode.clips[0].render.id = "replacement-render";
    const merged = preserveNewerReviews(previous, episode);
    expect(merged.clips[0].render.review.revision).toBe(0);
    expect(merged.clips[0].render.review.note).toBe("");
  });
});

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  change(value: DocumentVisibilityState) {
    this.visibilityState = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("visible-tab catalog polling", () => {
  it("only reads the stored same-origin catalog status; no import or Google request", async () => {
    const { status } = fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(status)));
    vi.stubGlobal("fetch", fetcher);
    await expect(api.catalogStatus()).resolves.toEqual(status);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/catalog/status",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it("waits between settled requests, pauses hidden tabs and resumes once visible", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const { status } = fixture();
    const read = vi.fn().mockResolvedValue(status);
    const onStatus = vi.fn();
    const stop = startVisibleCatalogPolling({
      visibility,
      read,
      onStatus,
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    visibility.change("hidden");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(2);
    visibility.change("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not request anything on an initially hidden page", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    visibility.change("hidden");
    const read = vi.fn().mockResolvedValue(fixture().status);
    const stop = startVisibleCatalogPolling({
      visibility,
      read,
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).not.toHaveBeenCalled();
    visibility.change("visible");
    expect(read).toHaveBeenCalledOnce();
    stop();
  });
  it("ignores a hidden-tab aborted response that arrives after a newer visible check", async () => {
    const visibility = new Visibility();
    const old = deferred<CatalogStatus>();
    const current = deferred<CatalogStatus>();
    const read = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const onStatus = vi.fn();
    const onError = vi.fn();
    const stop = startVisibleCatalogPolling({
      visibility,
      read,
      onStatus,
      onError,
    });
    const signal = read.mock.calls[0][0] as AbortSignal;
    visibility.change("hidden");
    expect(signal.aborted).toBe(true);
    visibility.change("visible");
    const latest = { ...fixture().status, version: 5 };
    current.resolve(latest);
    await current.promise;
    old.resolve(fixture().status);
    await old.promise;
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(latest);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
  it("never overlaps pending requests, reports failures and retries on cadence", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const pending = deferred<CatalogStatus>();
    const read = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(fixture().status);
    const onError = vi.fn();
    const onStatus = vi.fn();
    const stop = startVisibleCatalogPolling({
      visibility,
      read,
      onStatus,
      onError,
    });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(read).toHaveBeenCalledOnce();
    visibility.change("visible");
    expect(read).toHaveBeenCalledOnce();
    pending.reject(new Error("Network unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Network unavailable");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(onStatus).toHaveBeenCalledOnce();
    stop();
  });
  it("does not publish results or schedule another poll after unmount", async () => {
    vi.useFakeTimers();
    const visibility = new Visibility();
    const pending = deferred<CatalogStatus>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const onStatus = vi.fn();
    const stop = startVisibleCatalogPolling({
      visibility,
      read,
      onStatus,
      onError: vi.fn(),
    });
    stop();
    pending.resolve(fixture().status);
    await vi.advanceTimersByTimeAsync(120_000);
    visibility.change("visible");
    expect(onStatus).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });
});
