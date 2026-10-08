# Bounded transcript candidate matching

Offline, deterministic, dependency-free TypeScript functions for finding passages that merit human review. No network calls, database writes, production feed integration, speech recognition, learning, or calibrated AI confidence are implemented. This package is not wired to live RSS, the dashboard UI, or persistence.

## Contract

Import `findCandidatePassages`, `evidenceFreshness`, and `mapSourceRangeToRender` from `@twib/matching` (workspace import after root lockfile integration), or directly from `src/index.ts`.

`findCandidatePassages(source, episode)` accepts:

- A source or clip-render transcript, with its explicit coordinate space.
- A published-episode transcript in `published_episode` coordinates.
- Exact media-byte and transcript-edition fingerprints for both inputs. The caller computes and verifies them; a URL, title, source ID, approximate hash, or filename is not an edition fingerprint. Transcript fingerprints must include timings and cue kinds, not only words.
- Timed cues in ascending start-time order, milliseconds relative to the specified media, with explicit `kind`. Set `cues: null` when unavailable. An empty list is available but yields no evidence.

Only `speech` cues participate. Name metadata, chapter titles, show notes, other metadata, and URL-bearing cues are excluded. Adapters must correctly classify cues; this module cannot infer whether an arbitrary string incorrectly labeled speech is a list of names. Do not manufacture speech from show notes or title metadata.

### Synthetic API example

```ts
import {
  findCandidatePassages,
  evidenceFreshness,
  type Transcript,
} from "@twib/matching";

const speech =
  "The observatory team calibrated their instruments before sunrise while technicians inspected every mirror and recorded unusual temperature variations across the northern ridge during the winter survey.";
// Synthetic identifiers only. A real adapter supplies verified exact-byte/content hashes.
const source: Transcript = {
  edition: {
    mediaFingerprint: "synthetic-source-v1",
    transcriptFingerprint: "synthetic-cues-v1",
  },
  coordinateSpace: "source_media",
  cues: [{ startMs: 10000, endMs: 30000, text: speech, kind: "speech" }],
};
const episode: Transcript = {
  edition: {
    mediaFingerprint: "synthetic-episode-v1",
    transcriptFingerprint: "synthetic-episode-cues-v1",
  },
  coordinateSpace: "published_episode",
  cues: [{ startMs: 90000, endMs: 110000, text: speech, kind: "speech" }],
};
const evidence = findCandidatePassages(source, episode);
// evidence.status === 'CANDIDATE'; no aired/confirmed decision is made.
const freshness = evidenceFreshness(evidence, source, episode); // 'current'
```

The only statuses are `CANDIDATE` and `UNKNOWN`. Every result requires verification. Partial use can produce a candidate without implying full use. Neither unavailable transcripts nor absence of a match means rejected, not used, or not aired. This module has no confirmation transition. Text cannot establish which exact clip-render edition was published, even when its full transcript matches.

Passages include normalized source/episode excerpts, matched-token and edit counts, a lexical-distinctiveness count, exact/near-normalized quality, and ambiguity labels. These are transparent heuristic measurements, not probabilities or confidence scores. Excerpts can contain private input; callers must apply their normal access controls and must not log or publish them automatically.

Ranges enclose whole transcript cues. They are not word-level timestamps or frame-accurate edit points and can include unmatched words in the boundary cues. Candidate review must play the corresponding media and establish actual boundaries and provenance separately.

## Deterministic search

- Unicode tokenization preserves words, negation, decimals, signed numbers, percentages, and basic comparison/currency symbols. Common English negative contractions expand. Only `um`, `uh`, and `erm` are discarded. Ordinary function words are never stripped from matching. A small stopword set affects only the lexical-distinctiveness threshold.
- An exact eight-token seed starts an alignment. Exact left extension plus conservative right extension allows up to three single-token edits, gated by already matched length and a three-token exact continuation. Changed negation, numeric tokens, a small uncertainty/modal/quantity vocabulary, and comparison symbols cannot be smoothed over. This safeguard is deliberately not a semantic-equivalence detector; all near matches still require review.
- At least 24 matched tokens and ten distinct non-common words longer than two characters are required. These thresholds suppress short catchphrases and generic material; “distinctive” means this explicit lexical heuristic, not proof that a passage is globally unique.
- Search does not bridge metadata or gaps exceeding eight seconds. Alignments are capped at 180 tokens. Overlapping anchors are collapsed. Different source or episode locations sharing matching spans are marked `multiple_locations`. `not_detected` means ambiguity was not found in this bounded search, not proven uniqueness.
- Limits per transcript: 20,000 cues, two million characters, 30,000 normalized tokens. Invalid/oversized inputs throw. At most 20,000 seed pairs and 100 output passages are evaluated/retained; truncation returns `searchComplete: false`. Callers must display that limitation even when candidates were found. A truncated search with no passage is `UNKNOWN / search_limit_reached`.
- The index is linear in episode tokens with fixed seed length. Alignment work is bounded by the seed-pair and span caps, plus at most 100 retained-span comparisons per pair. The implementation has no unbounded all-pairs alignment matrix.

This conservative search can miss heavily rewritten, paraphrased, short, multilingual, inaccurately transcribed, or differently segmented uses. Spelling differences, number formatting, and editorial changes can split a match. It does not establish speaker identity, original ownership, audio identity, context, or meaning equivalence. Repeated passages may exhaust the search budget.

## Edition freshness and rendering

Persist the complete evidence with both edition objects and the algorithm version. Before showing evidence as current, use `evidenceFreshness(evidence, currentSource, currentEpisode)`. Any media/transcript fingerprint or coordinate-space change makes prior evidence stale. Recompute rather than silently carrying it over. These fingerprints are provenance bindings supplied by the caller; this module neither downloads nor hashes media.

Source-media milliseconds are not clip-render milliseconds. `mapSourceRangeToRender` accepts a separately supplied, exact-edition edit list. It maps a range only when one explicit segment covers it without overlapping alternatives. Linear scaling supports an explicitly described uniform speed change. Missing coverage, ranges crossing edits, and repeated/ambiguous source placements stay unmapped. Changed fingerprints also stay unmapped. Render identity established by that external edit list must not be confused with identity inferred from a transcript match.

## Suggested adapter behavior

1. Obtain authorized transcripts and verified edition fingerprints outside this module.
2. Classify cues and preserve their original coordinate spaces.
3. Compute candidates, retaining original transcripts under appropriate access controls.
4. Store candidate evidence separately from human-confirmed airing decisions; never invoke a confirmation mutation automatically.
5. On review, show both cue-bounded media ranges, partial-match and ambiguity warnings, any incomplete-search warning, and current/stale status.
6. Recompute whenever either edition changes. Only an explicit verification workflow may record an aired association and its scope.

## Validation

From repository root:

```
npx vitest run packages/matching
npx tsc -p packages/matching/tsconfig.json --noEmit
npx eslint packages/matching
```

All fixtures are synthetic. Root TypeScript, lint, workspace resolution, and Vitest checks include this package. No live connector or schema change is needed to use the pure functions.
