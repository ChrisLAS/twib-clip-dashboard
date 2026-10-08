import { describe, expect, it } from "vitest";
import {
  evidenceFreshness,
  findCandidatePassages,
  mapSourceRangeToRender,
  normalizeSpeech,
  type Transcript,
  type Cue,
} from "./index";
const passage =
  "The observatory team calibrated their instruments before sunrise while technicians inspected every mirror and recorded unusual temperature variations across the northern ridge during the winter survey.";
function transcript(text = passage, episode = false): Transcript {
  return {
    edition: {
      mediaFingerprint: episode
        ? "synthetic-episode-bytes-v1"
        : "synthetic-source-bytes-v1",
      transcriptFingerprint: "synthetic-timing-text-v1",
    },
    coordinateSpace: episode ? "published_episode" : "source_media",
    cues: [
      {
        startMs: episode ? 90000 : 10000,
        endMs: episode ? 110000 : 30000,
        text,
        kind: "speech",
      },
    ],
  };
}
const match = (source = passage, episode = passage) =>
  findCandidatePassages(transcript(source), transcript(episode, true));
describe("candidate matching", () => {
  it("returns cue bounded evidence requiring verification, never an aired assertion", () => {
    const result = match();
    expect(result.status).toBe("CANDIDATE");
    expect(result.requiresVerification).toBe(true);
    expect(result.exactRenderIdentity).toBe("not_established_by_text");
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]).toMatchObject({
      quality: "exact_normalized_passage",
      timingPrecision: "enclosing_cues",
      sourceRange: { startMs: 10000, endMs: 30000 },
      episodeRange: { startMs: 90000, endMs: 110000 },
    });
  });
  it("supports partial use without claiming the whole clip aired", () => {
    expect(
      match(
        `Unrelated opening. ${passage} Additional unused material.`,
        passage,
      ).passages[0].sourceExcerpt,
    ).toBe(passage.toLowerCase().slice(0, -1));
  });
  it("accepts cautious near matching with transparent edits", () => {
    const result = match(passage, passage.replace("recorded", "documented"));
    expect(
      result.passages.some(
        (p) => p.quality === "near_normalized_passage" && p.editedTokens === 1,
      ),
    ).toBe(true);
  });
  it.each(["chapter", "show_note", "name", "other_metadata"] as Cue["kind"][])(
    "ignores %s cues",
    (kind) => {
      const source = transcript();
      source.cues = [{ ...source.cues![0], kind }];
      expect(
        findCandidatePassages(source, transcript(passage, true)).status,
      ).toBe("UNKNOWN");
    },
  );
  it("ignores links and short generic catchphrases", () => {
    expect(match("Welcome back and thanks for listening").status).toBe(
      "UNKNOWN",
    );
    expect(
      match(
        `${passage} https://example.test/source`,
        `${passage} https://example.test/source`,
      ).status,
    ).toBe("UNKNOWN");
    expect(match("Alex Morgan Taylor", "Alex Morgan Taylor").status).toBe(
      "UNKNOWN",
    );
  });
  it("does not manufacture distinctiveness from repeated generic words", () => {
    const generic = "welcome back to the show ".repeat(20);
    expect(match(generic, generic).status).toBe("UNKNOWN");
  });
  it("keeps multiple episode locations ambiguous", () => {
    const episode = transcript(passage, true);
    episode.cues = [
      ...episode.cues!,
      { startMs: 120000, endMs: 140000, text: passage, kind: "speech" },
    ];
    const result = findCandidatePassages(transcript(), episode);
    expect(result.passages).toHaveLength(2);
    expect(
      result.passages.every((p) => p.ambiguity === "multiple_locations"),
    ).toBe(true);
  });
  it("also flags duplicate source passages", () => {
    const source = transcript();
    source.cues = [
      ...source.cues!,
      { startMs: 50000, endMs: 70000, text: passage, kind: "speech" },
    ];
    expect(
      findCandidatePassages(source, transcript(passage, true)).passages.every(
        (p) => p.ambiguity === "multiple_locations",
      ),
    ).toBe(true);
  });
  it("preserves negation, decimals, percentages, uncertainty, and meaningful function words", () => {
    expect(
      normalizeSpeech("Uh, we DON'T expect 3.5% or 35; perhaps it can't work."),
    ).toEqual([
      "we",
      "do",
      "not",
      "expect",
      "3.5%",
      "or",
      "35",
      "perhaps",
      "it",
      "can",
      "not",
      "work",
    ]);
    expect(normalizeSpeech("50%")).not.toEqual(normalizeSpeech("50"));
    expect(normalizeSpeech("3.5")).not.toEqual(normalizeSpeech("35"));
    expect(normalizeSpeech("-3.5")).not.toEqual(normalizeSpeech("3.5"));
  });
  it.each([
    ["not", "now"],
    ["3.5%", "35%"],
    ["50%", "50"],
    ["perhaps", "certainly"],
    ["twenty", "thirty"],
    ["-3.5", "3.5"],
    ["<", ">"],
  ])("does not bridge changed meaning %s → %s", (before, after) => {
    const words = passage.split(" ");
    words.splice(15, 0, before);
    expect(
      match(words.join(" "), words.join(" ").replace(before, after)).status,
    ).toBe("UNKNOWN");
  });
  it("ignores filler and punctuation without stripping negation", () => {
    expect(
      match(
        passage,
        `Um, ${passage.toUpperCase().replace("TEAM", "TEAM, UH,")}`,
      ).status,
    ).toBe("CANDIDATE");
  });
  it("never treats unavailable or missing evidence as rejection", () => {
    const source = transcript();
    source.cues = null;
    expect(
      findCandidatePassages(source, transcript(passage, true)),
    ).toMatchObject({ status: "UNKNOWN", reason: "transcript_unavailable" });
    expect(match(passage, "Entirely unrelated speech.")).toMatchObject({
      status: "UNKNOWN",
      reason: "no_distinctive_match",
    });
  });
  it("does not join speech through metadata or long silent gaps", () => {
    const words = passage.split(" "),
      source = transcript();
    source.cues = [
      {
        startMs: 0,
        endMs: 1000,
        text: words.slice(0, 15).join(" "),
        kind: "speech",
      },
      {
        startMs: 12000,
        endMs: 13000,
        text: words.slice(15).join(" "),
        kind: "speech",
      },
    ];
    expect(
      findCandidatePassages(source, transcript(passage, true)).status,
    ).toBe("UNKNOWN");
  });
  it("marks media, transcript, or coordinate edition changes stale", () => {
    const source = transcript(),
      episode = transcript(passage, true),
      evidence = findCandidatePassages(source, episode);
    expect(evidenceFreshness(evidence, source, episode)).toBe("current");
    source.edition.mediaFingerprint = "synthetic-source-bytes-v2";
    expect(evidenceFreshness(evidence, source, episode)).toBe("stale");
    expect(evidence.sourceEdition.mediaFingerprint).toBe(
      "synthetic-source-bytes-v1",
    );
    expect(
      evidenceFreshness(evidence, transcript(), {
        ...episode,
        edition: { ...episode.edition, transcriptFingerprint: "v2" },
      }),
    ).toBe("stale");
    expect(
      evidenceFreshness(
        evidence,
        { ...transcript(), coordinateSpace: "clip_render" },
        episode,
      ),
    ).toBe("stale");
  });
  it("validates timing, fingerprints, cue kind, and bounded inputs", () => {
    const source = transcript();
    source.cues = [{ ...source.cues![0], startMs: NaN }];
    expect(() =>
      findCandidatePassages(source, transcript(passage, true)),
    ).toThrow(/timings/);
    expect(() => match("word ".repeat(30001))).toThrow(/token limit/);
    expect(() =>
      findCandidatePassages(
        {
          ...transcript(),
          edition: { mediaFingerprint: "", transcriptFingerprint: "v1" },
        },
        transcript(passage, true),
      ),
    ).toThrow(/fingerprints/);
  });
  it("reports bounded-search truncation explicitly, not absence or disambiguation", () => {
    const result = match("word ".repeat(220), "word ".repeat(220));
    expect(result).toMatchObject({
      status: "UNKNOWN",
      reason: "search_limit_reached",
      searchComplete: false,
    });
  });
});
describe("explicit render mapping", () => {
  const mapping = {
    sourceMediaFingerprint: "source-v1",
    renderMediaFingerprint: "render-v1",
    segments: [
      {
        source: { startMs: 10000, endMs: 30000 },
        render: { startMs: 2000, endMs: 22000 },
      },
    ],
  };
  it("maps source coordinates only with matching explicit edit-list fingerprints", () => {
    expect(
      mapSourceRangeToRender(
        { startMs: 12000, endMs: 16000 },
        mapping,
        "source-v1",
        "render-v1",
      ),
    ).toEqual({
      status: "mapped",
      basis: "explicit_edit_list",
      range: { startMs: 4000, endMs: 8000 },
    });
    expect(
      mapSourceRangeToRender(
        { startMs: 12000, endMs: 16000 },
        mapping,
        "source-v2",
        "render-v1",
      ),
    ).toMatchObject({ status: "unmapped", reason: "edition_changed" });
  });
  it("rejects a partly overlapping alternate mapping and empty identities", () => {
    const partial = {
      source: { startMs: 14000, endMs: 19000 },
      render: { startMs: 50000, endMs: 55000 },
    };
    expect(
      mapSourceRangeToRender(
        { startMs: 12000, endMs: 16000 },
        { ...mapping, segments: [...mapping.segments, partial] },
        "source-v1",
        "render-v1",
      ).status,
    ).toBe("unmapped");
    expect(() =>
      mapSourceRangeToRender(
        { startMs: 12000, endMs: 16000 },
        mapping,
        "",
        "render-v1",
      ),
    ).toThrow(/fingerprints/);
  });
  it("does not guess offsets across edits or ambiguous repeated uses", () => {
    expect(
      mapSourceRangeToRender(
        { startMs: 9000, endMs: 16000 },
        mapping,
        "source-v1",
        "render-v1",
      ).status,
    ).toBe("unmapped");
    expect(
      mapSourceRangeToRender(
        { startMs: 12000, endMs: 16000 },
        { ...mapping, segments: [...mapping.segments, ...mapping.segments] },
        "source-v1",
        "render-v1",
      ).status,
    ).toBe("unmapped");
  });
});

describe("overlapping transcript cue bounds", () => {
  it("encloses every matched cue when an earlier cue ends later", () => {
    const words = passage.split(" ");
    const source = transcript();
    const episode = transcript(passage, true);
    source.cues = [
      {
        startMs: 0,
        endMs: 10000,
        text: words.slice(0, 15).join(" "),
        kind: "speech",
      },
      {
        startMs: 1000,
        endMs: 2000,
        text: words.slice(15).join(" "),
        kind: "speech",
      },
    ];
    episode.cues = [
      {
        startMs: 100000,
        endMs: 120000,
        text: words.slice(0, 15).join(" "),
        kind: "speech",
      },
      {
        startMs: 101000,
        endMs: 104000,
        text: words.slice(15).join(" "),
        kind: "speech",
      },
    ];
    const result = findCandidatePassages(source, episode);
    expect(result.status).toBe("CANDIDATE");
    expect(result.passages[0]).toMatchObject({
      sourceRange: { startMs: 0, endMs: 10000 },
      episodeRange: { startMs: 100000, endMs: 120000 },
      timingPrecision: "enclosing_cues",
    });
  });
});
