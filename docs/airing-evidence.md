# Airing candidate workflow

This workflow persists transcript candidates separately from owner decisions. It never interprets absence as rejection or non-use, chapter titles as evidence, or a text match as proof of an exact rendered file. No paid services, model API, new credentials, or automated source-media downloads are needed.

## Read and produce

An authenticated owner can GET `/api/airing/input?renderId=...&episodeId=...`. It returns the immutable render, canonical source fingerprint and current normalized published transcript, if available. The public feed ingestion must map the publication to exactly one episode workspace and have a current successful transcript fetch. This output contains private render context and must stay private. Never save it in this repository.

Run Node 24+ locally on an authorized private input file:

    node packages/matching/bin/candidate.mjs private-input.json private-candidate.json

The CLI is offline and creates a new mode-0600 output file without overwriting existing data. It uses the bounded passage matcher and includes at most 20 passages, marking truncation as incomplete. It requires a verified render-relative transcript mapping and exact render artifact hash. It never downloads media, submits requests, or confirms airing.

The published episode's media-byte fingerprint remains null. Its metadata edition fingerprint and original/normalized transcript hashes are distinct from media identity. The extended matcher permits explicitly unknown media identity; freshness comparisons do not turn unknown identity into proof.

POST the resulting JSON to `/api/airing/evidence` only through an already-authorized owner session and normal CSRF guard. No producer service token or background matching runtime is connected. The endpoint validates bounds, immutable source/render fingerprints and current published edition before storing a candidate. It is not a general importer for owner confirmations.

## Review and corrections

Open a clip and expand “Airing evidence & owner verification”. Candidate excerpts show clip-relative and published-episode cue ranges, incomplete-search and multiple-location warnings, and whether evidence is stale. These are cue envelopes, not exact cut points. Listening to the published episode and comparing the exact clip render is required before explicit full/partial confirmation. A note, mark-unknown action and undo retain append-only history. Undo withdraws a confirmation rather than resurrecting a previous positive claim.

Mutations are revision-checked and idempotent. Uncertain browser saves retain their exact request and request key across navigation/reload. A source/render or publication-edition change makes previous evidence historical; it cannot be reconfirmed as current. Stale decisions can still be withdrawn. Chapter data is available for navigation, never used as match proof.

The panel currently provides passage timestamps and excerpts; it does not stream published episode media or seek a separate episode player. Existing clip timeline/source mapping behavior stays unchanged. Archived render reviews remain exact-render history.

## Operational limits

Apply migrations 0005 through 0007 before exposing these routes. Ingestion and decisions use existing Access authorization and POST CSRF guards. Keep public feed allowlists private. Do not forge owner requests for deployment smoke tests. Unit/SQLite checks and synthetic browser checks do not establish live owner playback or a connected producer.

Edge Workers do not run the passage matcher automatically: the 50ms CPU ceiling is unchanged. Actual candidate generation is an explicit offline step until a separately authorized runner is connected. Do not report automatic “did this air” tracking as live merely because a candidate API exists.
