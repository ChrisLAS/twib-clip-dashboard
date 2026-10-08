import { describe, it, expect } from "vitest";
import { produceAiringCandidate, type CandidateInput } from "./producer";
const text =
  "The observatory team calibrated their instruments before sunrise while technicians inspected every mirror and recorded unusual temperature variations across the northern ridge during the winter survey.";
function fixture(): CandidateInput {
  return {
    sourceFingerprint: "a".repeat(64),
    render: {
      id: "render",
      clipId: "clip",
      durationMs: 10000,
      artifactHash: "b".repeat(64),
      mappingVerified: true,
      cues: [{ id: "cue", text, startMs: 0, endMs: 10000 }],
    } as CandidateInput["render"],
    publication: {
      edition: {
        episodeId: "episode",
        editionFingerprint: "c".repeat(64),
        transcriptHash: "d".repeat(64),
        transcriptNormalizedHash: "e".repeat(64),
        mediaFingerprint: null,
      } as NonNullable<CandidateInput["publication"]>["edition"],
      coordinateSpace: "published_episode",
      cues: [{ text, startMs: 20000, endMs: 30000, kind: "speech" }],
    },
  };
}
describe("offline airing producer", () => {
  it("produces candidate with unknown episode media identity, never confirmation", () => {
    const result = produceAiringCandidate(fixture(), "request-key");
    expect(result.status).toBe("CANDIDATE");
    expect(result.exactRenderIdentity).toBe("not_established_by_text");
    expect(result.passages[0].episodeRange.startMs).toBe(20000);
    expect(result).not.toHaveProperty("decision");
  });
  it("does not manufacture source mappings or unavailable transcripts", () => {
    const v = fixture();
    v.render.mappingVerified = false;
    expect(() => produceAiringCandidate(v, "request-key")).toThrow(/mapping/);
    v.render.mappingVerified = true;
    v.publication = null;
    expect(() => produceAiringCandidate(v, "request-key")).toThrow(/unknown/);
  });
  it("chapters alone remain unknown", () => {
    const v = fixture();
    v.publication!.cues[0].kind = "chapter";
    expect(produceAiringCandidate(v, "request-key").status).toBe("UNKNOWN");
  });
});

it("rejects relabeled coordinates and out-of-range exact render cues", () => {
  const v = fixture();
  v.publication!.coordinateSpace = "source_media" as "published_episode";
  expect(() => produceAiringCandidate(v, "request-key")).toThrow(/coordinates/);
  v.publication!.coordinateSpace = "published_episode";
  v.render.durationMs = 9999;
  expect(() => produceAiringCandidate(v, "request-key")).toThrow(/duration/);
});
it("does not substitute a URL for publication content identity", () => {
  const v = fixture();
  v.publication!.edition.transcriptHash = "https://example.com/transcript";
  expect(() => produceAiringCandidate(v, "request-key")).toThrow(
    /fingerprints/,
  );
});
