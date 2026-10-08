# Airing candidate workflow

This workflow persists transcript candidates separately from owner decisions. It never interprets absence as rejection or non-use, chapter titles as evidence, or a text match as proof of an exact rendered file. No paid services, model API, new credentials, or automated source-media downloads are needed.

## Read and produce

An authenticated owner can GET `/api/airing/input?renderId=...&episodeId=...`. It returns the immutable render, canonical source fingerprint and current normalized published transcript, if available. The public feed ingestion must map the publication to exactly one episode workspace and have a current successful transcript fetch. This output contains private render context and must stay private. Never save it in this repository.

Run Node 24+ locally on an authorized private input file:

    node packages/matching/bin/candidate.mjs private-input.json private-candidate.json

The CLI is offline and creates a new mode-0600 output file without overwriting existing data. It uses the bounded passage matcher and includes at most 20 passages, marking truncation as incomplete. It requires an exact render artifact hash and either a verified legacy render-relative transcript mapping or a separate exact-render transcript asset (described below). It never downloads media, submits requests, or confirms airing.

The published episode's media-byte fingerprint remains null. Its metadata edition fingerprint and original/normalized transcript hashes are distinct from media identity. The extended matcher permits explicitly unknown media identity; freshness comparisons do not turn unknown identity into proof.

POST the resulting JSON to `/api/airing/evidence` only through an already-authorized owner session and normal CSRF guard. No producer service token or background matching runtime is connected. The endpoint validates bounds, immutable source/render fingerprints and current published edition before storing a candidate. It is not a general importer for owner confirmations.

## Review and corrections

Open a clip and expand “Airing evidence & owner verification”. Candidate excerpts show clip-relative and published-episode cue ranges, incomplete-search and multiple-location warnings, and whether evidence is stale. These are cue envelopes, not exact cut points. Listening to the published episode and comparing the exact clip render is required before explicit full/partial confirmation. A note, mark-unknown action and undo retain append-only history. Undo withdraws a confirmation rather than resurrecting a previous positive claim.

Mutations are revision-checked and idempotent. Uncertain browser saves retain their exact request and request key across navigation/reload. A source/render or publication-edition change makes previous evidence historical; it cannot be reconfirmed as current. Stale decisions can still be withdrawn. Chapter data is available for navigation, never used as match proof.

The panel currently provides passage timestamps and excerpts; it does not stream published episode media or seek a separate episode player. Existing clip timeline/source mapping behavior stays unchanged. Archived render reviews remain exact-render history.

## Operational limits

Apply migrations 0005 through 0008 before exposing these routes. Ingestion and decisions use existing Access authorization and POST CSRF guards. Keep public feed allowlists private. Do not forge owner requests for deployment smoke tests. Unit/SQLite checks and synthetic browser checks do not establish live owner playback or a connected producer.

Edge Workers do not run the passage matcher automatically: the 50ms CPU ceiling is unchanged. Actual candidate generation is an explicit offline step until a separately authorized runner is connected. Do not report automatic “did this air” tracking as live merely because a candidate API exists.

## Exact-render machine transcripts (migration 0008)

An immutable render whose original `mappingVerified` is false stays unchanged. An independently generated machine transcript of that exact hashed render can instead be imported as a separate owner-scoped observation. It supplies clip-relative timing for candidate matching, never a source-media offset, verified wording, or proof the file aired. The source timeline and archived review behavior remain unchanged.

POST `/api/renders/:renderId/transcripts` through the existing owner session and CSRF guard with:

    { "idempotencyKey": "new-request-key", "renderId": "exact-render-id",
      "mediaSha256": "64-lowercase-hex-sha256-of-exact-render-bytes",
      "origin": "machine_asr", "alignment": "exact_render",
      "textAccuracy": "unverified", "sourceMapping": "unknown",
      "cues": [{ "id": "asr-1", "startMs": 0, "endMs": 1000, "text": "Machine words" }] }

The media hash must match the stored render artifact hash. Cue IDs must be unique, ranges must be integer milliseconds, positive, ordered and nonoverlapping, and every end must be inside the stored exact render duration. This import contract intentionally does not accept overlapping subtitle cues. At most 10,000 cues and 500,000 text characters are accepted. Normalize the actual ASR segments before import; do not relabel a source transcript or pretend text accuracy was verified. This endpoint does not fetch arbitrary media, create credentials, or run ASR.

The server computes `transcriptHash` over the canonical timed cues and `assetHash` over the exact render binding, duration, fixed provenance and transcript content. The returned asset is immutable, owner-scoped and content-deduplicated. A repeated content import returns the original asset and does not advance the selected version. Content corrections create new observations. For each owner and exact render hash, the most recently inserted asset is current, determined by database insertion order rather than timestamp precision.

GET `/api/airing/input` returns `sourceTranscriptAsset` when available and a source fingerprint bound to that asset ID and hash independently of the original render metadata. The offline producer accepts its cues even when the original source mapping is unknown. Candidate evidence carries `sourceTranscriptAssetId` and `sourceTranscriptAssetHash` together and remains permanently pinned to them. A later correction makes older evidence stale; it never silently points existing evidence at new words. Positive owner verification checks the selected asset, exact render snapshot, current clip render and publication edition again inside the atomic database operation. Historical unknown/undo actions remain available. With no asset, the legacy verified-render cue path and fingerprint format are preserved.

For an already-authorized private D1 bootstrap, call the exported `importRenderTranscriptAsset(db, input, owner)` using a supported bound D1 adapter. It applies the same schema, `prepareRenderTranscriptAsset` canonical hashing and atomic operation receipts as the owner API. The pure prepare helper is available for local validation, but generating an object alone does not persist it. Verify existing receipt/asset state and read back the import result before retrying an uncertain operation; keep private input and output outside this repository. Do not forge Access headers or owner HTTP sessions. Migration 0008 adds independent SQL identity, immutable-history and current-asset race guards; the prior render/publication guards remain active. Direct raw SQL is not a substitute for the canonical validator and hash builder.
