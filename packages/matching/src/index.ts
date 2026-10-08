/** Credential-free evidence discovery. No result from this module confirms airing. */
export interface Edition {
  /** Caller-computed fingerprint of exact media bytes; not a title, URL, or filename. */
  mediaFingerprint: string;
  /** Caller-computed fingerprint of transcript text, timings, and cue kinds. */
  transcriptFingerprint: string;
}
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
  kind: "speech" | "chapter" | "show_note" | "name" | "other_metadata";
}
export interface Transcript {
  edition: Edition;
  coordinateSpace: "source_media" | "clip_render" | "published_episode";
  cues: readonly Cue[] | null;
}
export interface Range {
  startMs: number;
  endMs: number;
}
export interface Passage {
  sourceRange: Range;
  episodeRange: Range;
  /** Timing is only as precise as enclosing transcript cues; never word-exact. */
  timingPrecision: "enclosing_cues";
  quality: "exact_normalized_passage" | "near_normalized_passage";
  matchedTokens: number;
  editedTokens: number;
  distinctiveTokens: number;
  ambiguity: "multiple_locations" | "not_detected";
  sourceExcerpt: string;
  episodeExcerpt: string;
}
export interface Evidence {
  algorithmVersion: "bounded-passage-v1";
  status: "CANDIDATE" | "UNKNOWN";
  reason:
    | "passages_require_verification"
    | "transcript_unavailable"
    | "no_distinctive_match"
    | "search_limit_reached";
  sourceEdition: Edition;
  episodeEdition: Edition;
  sourceCoordinateSpace: "source_media" | "clip_render";
  exactRenderIdentity: "not_established_by_text";
  requiresVerification: true;
  searchComplete: boolean;
  passages: Passage[];
}
const SEED = 8;
const MIN_TOKENS = 24;
const MAX_TOKENS = 30_000;
const MAX_SEED_PAIRS = 20_000;
const MAX_PASSAGES = 100;
const MAX_SPAN = 180;
const NEGATION = new Set([
  "not",
  "no",
  "never",
  "neither",
  "nor",
  "without",
  "cannot",
]);
const MEANING_SENSITIVE = new Set(
  "perhaps possibly probably allegedly reportedly uncertain unlikely likely maybe only all none some most few less more zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion percent percentage might may could should must will would can".split(
    " ",
  ),
);
const protectedToken = (word: string) =>
  NEGATION.has(word) ||
  MEANING_SENSITIVE.has(word) ||
  /[\p{N}%±<>=+$€£]/u.test(word);
const COMMON = new Set(
  "a an the this that these those is are was were be been being i you he she it we they me my your our their to of for from in on at by and or but so as with have has had do does did will would can could should may might there here then than just really very".split(
    " ",
  ),
);
interface Token {
  value: string;
  cue: number;
  segment: number;
}

/** Only hesitation sounds are dropped; negation and ordinary function words remain. */
export function normalizeSpeech(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/\bwon't\b/g, "will not")
      .replace(/\bcan't\b/g, "can not")
      .replace(/n't\b/g, " not")
      .replace(/\bcannot\b/g, "can not")
      .match(
        /[+-]?\p{N}+(?:[.,]\p{N}+)*(?:%)?|[%±<>=+$€£]|[\p{L}]+(?:'[\p{L}]+)*/gu,
      )
      ?.filter((word) => !["um", "uh", "erm"].includes(word)) ?? []
  );
}
function validate(input: Transcript): void {
  if (
    !input.edition.mediaFingerprint.trim() ||
    !input.edition.transcriptFingerprint.trim()
  )
    throw new Error(
      "Exact media and transcript edition fingerprints are required",
    );
  if (!input.cues) return;
  if (input.cues.length > 20_000)
    throw new Error("Transcript exceeds 20,000 cue limit");
  let previous = -1;
  let characters = 0;
  for (const cue of input.cues) {
    if (
      !Number.isFinite(cue.startMs) ||
      !Number.isFinite(cue.endMs) ||
      cue.startMs < previous ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs
    )
      throw new Error("Cues must have ordered, finite, nonnegative timings");
    if (
      !["speech", "chapter", "show_note", "name", "other_metadata"].includes(
        cue.kind,
      )
    )
      throw new Error("Explicit cue kind is required");
    characters += cue.text.length;
    if (characters > 2_000_000)
      throw new Error("Transcript exceeds character limit");
    previous = cue.startMs;
  }
}
function tokenize(input: Transcript): Token[] {
  const tokens: Token[] = [];
  let segment = 0;
  let previousEnd = -1;
  input.cues?.forEach((cue, index) => {
    // Metadata and URL-bearing cues cannot be the basis of a match.
    if (cue.kind !== "speech" || /https?:\/\/|www\./i.test(cue.text)) {
      segment++;
      return;
    }
    if (cue.startMs - previousEnd > 8_000) segment++;
    for (const value of normalizeSpeech(cue.text)) {
      tokens.push({ value, cue: index, segment });
      if (tokens.length > MAX_TOKENS)
        throw new Error("Transcript exceeds 30,000 normalized token limit");
    }
    previousEnd = cue.endMs;
  });
  return tokens;
}
function key(tokens: Token[], offset: number): string | null {
  if (
    offset + SEED > tokens.length ||
    tokens[offset].segment !== tokens[offset + SEED - 1].segment
  )
    return null;
  return tokens
    .slice(offset, offset + SEED)
    .map((t) => t.value)
    .join(" ");
}
function range(
  input: Transcript,
  tokens: Token[],
  start: number,
  end: number,
): Range {
  // Ordered cue starts do not imply ordered ends: overlapping or nested
  // speech cues must all be enclosed by the reported candidate interval.
  const cueIds = new Set(tokens.slice(start, end).map((token) => token.cue));
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const cueId of cueIds) {
    const cue = input.cues![cueId];
    startMs = Math.min(startMs, cue.startMs);
    endMs = Math.max(endMs, cue.endMs);
  }
  return { startMs, endMs };
}
function sameEdition(a: Edition, b: Edition): boolean {
  return (
    a.mediaFingerprint === b.mediaFingerprint &&
    a.transcriptFingerprint === b.transcriptFingerprint
  );
}
export function evidenceFreshness(
  evidence: Evidence,
  source: Transcript,
  episode: Transcript,
): "current" | "stale" {
  return sameEdition(evidence.sourceEdition, source.edition) &&
    sameEdition(evidence.episodeEdition, episode.edition) &&
    evidence.sourceCoordinateSpace === source.coordinateSpace &&
    episode.coordinateSpace === "published_episode"
    ? "current"
    : "stale";
}

/** Deterministic heuristic, intentionally conservative. Absence is UNKNOWN, never non-use. */
export function findCandidatePassages(
  source: Transcript,
  episode: Transcript,
): Evidence {
  validate(source);
  validate(episode);
  if (
    source.coordinateSpace === "published_episode" ||
    episode.coordinateSpace !== "published_episode"
  )
    throw new Error(
      "Expected source/clip coordinates and published episode coordinates",
    );
  const result: Evidence = {
    algorithmVersion: "bounded-passage-v1",
    status: "UNKNOWN",
    reason: "no_distinctive_match",
    sourceEdition: { ...source.edition },
    episodeEdition: { ...episode.edition },
    sourceCoordinateSpace: source.coordinateSpace,
    exactRenderIdentity: "not_established_by_text",
    requiresVerification: true,
    searchComplete: true,
    passages: [],
  };
  if (source.cues === null || episode.cues === null) {
    result.reason = "transcript_unavailable";
    return result;
  }
  const a = tokenize(source),
    b = tokenize(episode);
  const index = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const seed = key(b, j);
    if (seed !== null) {
      const locations = index.get(seed) ?? [];
      locations.push(j);
      index.set(seed, locations);
    }
  }
  const spans: { a0: number; a1: number; b0: number; b1: number }[] = [];
  let pairs = 0;
  outer: for (let i = 0; i < a.length; i++) {
    const seed = key(a, i);
    if (seed === null) continue;
    for (const j of index.get(seed) ?? []) {
      if (++pairs > MAX_SEED_PAIRS) {
        result.searchComplete = false;
        break outer;
      }
      if (
        spans.some(
          (s) =>
            i >= s.a0 &&
            i + SEED <= s.a1 &&
            j >= s.b0 &&
            j + SEED <= s.b1 &&
            i - s.a0 === j - s.b0,
        )
      )
        continue;
      let a0 = i,
        b0 = j,
        a1 = i + SEED,
        b1 = j + SEED;
      while (
        a0 > 0 &&
        b0 > 0 &&
        i - a0 < MAX_SPAN / 2 &&
        a[a0 - 1].segment === a[i].segment &&
        b[b0 - 1].segment === b[j].segment &&
        a[a0 - 1].value === b[b0 - 1].value
      ) {
        a0--;
        b0--;
      }
      let matches = a1 - a0,
        edits = 0;
      while (
        a1 < a.length &&
        b1 < b.length &&
        a1 - a0 < MAX_SPAN &&
        b1 - b0 < MAX_SPAN &&
        a[a1].segment === a[i].segment &&
        b[b1].segment === b[j].segment
      ) {
        if (a[a1].value === b[b1].value) {
          a1++;
          b1++;
          matches++;
          continue;
        }
        // Require a stable three-token continuation. Never smooth over changed negation.
        if (
          edits >= 3 ||
          edits + 1 > Math.floor(matches / 12) ||
          protectedToken(a[a1].value) ||
          protectedToken(b[b1].value)
        )
          break;
        const continuation = (da: number, db: number) =>
          [0, 1, 2].every(
            (k) =>
              a[a1 + da + k]?.segment === a[i].segment &&
              b[b1 + db + k]?.segment === b[j].segment &&
              a[a1 + da + k]?.value === b[b1 + db + k]?.value,
          );
        if (continuation(1, 1)) {
          a1++;
          b1++;
          edits++;
        } else if (continuation(1, 0)) {
          a1++;
          edits++;
        } else if (continuation(0, 1)) {
          b1++;
          edits++;
        } else break;
      }
      const distinct = new Set(
        a
          .slice(a0, a1)
          .filter((t) => !COMMON.has(t.value) && t.value.length > 2)
          .map((t) => t.value),
      ).size;
      if (matches < MIN_TOKENS || distinct < 10) continue;
      // Keep separate repeated locations; collapse overlapping anchors for the same passage.
      if (
        spans.some(
          (s) =>
            Math.min(a1, s.a1) - Math.max(a0, s.a0) > (a1 - a0) / 2 &&
            Math.min(b1, s.b1) - Math.max(b0, s.b0) > (b1 - b0) / 2,
        )
      )
        continue;
      if (result.passages.length >= MAX_PASSAGES) {
        result.searchComplete = false;
        break outer;
      }
      spans.push({ a0, a1, b0, b1 });
      result.passages.push({
        sourceRange: range(source, a, a0, a1),
        episodeRange: range(episode, b, b0, b1),
        timingPrecision: "enclosing_cues",
        quality: edits ? "near_normalized_passage" : "exact_normalized_passage",
        matchedTokens: matches,
        editedTokens: edits,
        distinctiveTokens: distinct,
        ambiguity: "not_detected",
        sourceExcerpt: a
          .slice(a0, a1)
          .map((t) => t.value)
          .join(" "),
        episodeExcerpt: b
          .slice(b0, b1)
          .map((t) => t.value)
          .join(" "),
      });
    }
  }
  result.passages.forEach((passage, i) => {
    if (
      spans.some(
        (s, j) =>
          j !== i &&
          (Math.min(s.a1, spans[i].a1) > Math.max(s.a0, spans[i].a0) ||
            Math.min(s.b1, spans[i].b1) > Math.max(s.b0, spans[i].b0)),
      )
    )
      passage.ambiguity = "multiple_locations";
  });
  if (result.passages.length) {
    result.status = "CANDIDATE";
    result.reason = "passages_require_verification";
  } else if (!result.searchComplete) result.reason = "search_limit_reached";
  return result;
}

export interface RenderMapping {
  sourceMediaFingerprint: string;
  renderMediaFingerprint: string;
  /** Explicit edit-list timing, never inferred from matching transcript text. */
  segments: readonly { source: Range; render: Range }[];
}
export type MappedRange =
  | { status: "mapped"; range: Range; basis: "explicit_edit_list" }
  | {
      status: "unmapped";
      reason: "edition_changed" | "no_single_unambiguous_segment";
    };
/** A range crossing edits intentionally needs a richer edit-list adapter, not guessed offsets. */
export function mapSourceRangeToRender(
  input: Range,
  mapping: RenderMapping,
  sourceMediaFingerprint: string,
  renderMediaFingerprint: string,
): MappedRange {
  if (
    ![
      mapping.sourceMediaFingerprint,
      mapping.renderMediaFingerprint,
      sourceMediaFingerprint,
      renderMediaFingerprint,
    ].every((value) => value.trim())
  )
    throw new Error("Exact mapping media fingerprints are required");
  if (
    mapping.sourceMediaFingerprint !== sourceMediaFingerprint ||
    mapping.renderMediaFingerprint !== renderMediaFingerprint
  )
    return { status: "unmapped", reason: "edition_changed" };
  const validRange = (r: Range) =>
    Number.isFinite(r.startMs) &&
    Number.isFinite(r.endMs) &&
    r.startMs >= 0 &&
    r.endMs > r.startMs;
  if (
    !validRange(input) ||
    mapping.segments.some((s) => !validRange(s.source) || !validRange(s.render))
  )
    throw new Error("Mapping ranges must be finite positive intervals");
  const segments = mapping.segments.filter(
    (s) => s.source.startMs <= input.startMs && s.source.endMs >= input.endMs,
  );
  const overlapping = mapping.segments.filter(
    (s) => s.source.startMs < input.endMs && s.source.endMs > input.startMs,
  );
  if (segments.length !== 1 || overlapping.length !== 1)
    return { status: "unmapped", reason: "no_single_unambiguous_segment" };
  const s = segments[0],
    scale =
      (s.render.endMs - s.render.startMs) / (s.source.endMs - s.source.startMs);
  return {
    status: "mapped",
    basis: "explicit_edit_list",
    range: {
      startMs: s.render.startMs + (input.startMs - s.source.startMs) * scale,
      endMs: s.render.startMs + (input.endMs - s.source.startMs) * scale,
    },
  };
}
