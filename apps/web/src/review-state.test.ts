import { describe, it, expect } from "vitest";
import { canSeekMedia, productionLabel } from "./review-state";
import { demoEpisode } from "./demo";
describe("playback failure recovery rules", () => {
  it("allows seeking only after playable metadata with a verified mapping", () => {
    expect(canSeekMedia(true, true, true, "")).toBe(true);
    expect(canSeekMedia(false, true, true, "")).toBe(false);
    expect(canSeekMedia(true, false, true, "")).toBe(false);
    expect(canSeekMedia(true, true, false, "")).toBe(false);
  });
  it("blocks seeking after a media error, including previously loaded media", () =>
    expect(canSeekMedia(true, true, true, "Access expired")).toBe(false));
  it("remains blocked during retry until metadata loads again", () =>
    expect(canSeekMedia(true, true, false, "")).toBe(false));
});
describe("compact production status", () => {
  const p = demoEpisode.clips[0].production;
  it("keeps blocker evidence ahead of a stale timestamp", () =>
    expect(
      productionLabel({
        ...p,
        state: "blocked",
        blocker: "Source denied",
        stale: true,
      }),
    ).toBe("Blocked"));
  it("does not represent stale readiness as current readiness", () =>
    expect(productionLabel({ ...p, state: "ready", stale: true })).toBe(
      "Stale · status unknown",
    ));
  it("shows current ready and failed states", () => {
    expect(productionLabel({ ...p, state: "ready", stale: false })).toBe(
      "Ready for review",
    );
    expect(productionLabel({ ...p, state: "failed", stale: true })).toBe(
      "Failed",
    );
  });
});
