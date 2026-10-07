import { describe, it, expect } from "vitest";
import { duration, timecode, date } from "./api";
import { demoEpisode, thumbnail } from "./demo";
describe("review display utilities", () => {
  it("formats rounded render durations without decimal seconds", () => {
    expect(duration(116800)).toBe("1:57");
    expect(duration(41000)).toBe("0:41");
  });
  it("keeps millisecond source boundaries", () =>
    expect(timecode(2406170)).toBe("00:40:06.170"));
  it("labels absent source dates as unknown", () =>
    expect(date(null)).toBe("Unknown"));
});
describe("explicit local fixture", () => {
  it("contains five fictional cuts and no playable media or invented transcript", () => {
    expect(demoEpisode.clips).toHaveLength(5);
    for (const c of demoEpisode.clips) {
      expect(c.render.mediaAvailable).toBe(false);
      expect(c.render.cues).toEqual([]);
      expect(c.airing.state).toBe("unknown");
      expect(c.render.review.decision).toBe("clear");
      expect(c.render.mappingVerified).toBe(false);
    }
  });
  it("does not claim a producer heartbeat", () => {
    expect(demoEpisode.sync.lastSuccessAt).toBe(null);
    for (const c of demoEpisode.clips)
      expect(c.production.lastProgressAt).toBe(null);
  });
  it("uses local generated artwork only", () => {
    for (const c of demoEpisode.clips)
      expect(thumbnail(c)).toMatch(/^\/demo\/[a-z]+\.svg$/);
  });
});
