import { describe, expect, it } from "vitest";
import { airingTargetLabel, shortFingerprint } from "./airing-target";
import type { Episode } from "@twib/shared";
describe("airing target identity", () => {
  it("uses supplied metadata and keeps the unambiguous ID", () => {
    const episode = {
      id: "published-one",
      number: 1,
      title: "Fictional title",
    } as Episode;
    expect(airingTargetLabel(episode.id, [episode])).toBe(
      "Episode 1 · Fictional title (published-one)",
    );
  });
  it("does not invent a number or title for an unknown target", () => {
    expect(airingTargetLabel("published-other", [])).toBe(
      "Episode published-other",
    );
  });
  it("keeps edition and transcript display deterministic", () => {
    expect(shortFingerprint("abcdef012345" + "f".repeat(52))).toBe(
      "abcdef012345",
    );
  });
});
