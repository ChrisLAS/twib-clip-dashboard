# Inventory row review candidate

This isolated candidate extends the local-playback base f01e253. It sorts the complete episode result before pagination by filename or first-observed date, with literal folder grouping and ascending/descending options. First-observed uses an available producer date, otherwise the earliest retained scan; first-received remains a separate fact. Cursor context includes filters and an observation watermark.

Each expanded clip row contains its local player, persistent notes and explicit Approve, Reject, Cut down and Unreviewed actions. Decisions apply to a bounded observed metadata version. Changes invalidate the effective decision while retaining notes. Rejection, revision and long/unknown-duration approval require explanations. These actions do not move files, start cuts or mark capture readiness. Owner authentication, same-origin CSRF and optimistic review revisions guard writes. Immutable operation IDs make retries replay safely.

The optional producer_record extends the existing manifest without inventing a parallel clip registry. The offline scripts/number_one_producer_record.py adapter uses existing manual-layout clip UID or processing/capture identity and exact current episode-relative paths. Historical paths are not current locations. Duplicate identities block decisions and appear Unreviewed; there is no automatic hash/path merge. Legacy observations retain their existing item identity. Renames can retain reviews when unambiguous producer identity is supplied. Size/mtime and producer-declared hashes are metadata evidence, not independent content verification.

The adapter is not installed on Nomad or connected to a live collector. Existing snapshots therefore use legacy fallback unless producer metadata is explicitly supplied. Fresh metadata and coordinated collector integration require future authorization; no source JSON or media was changed for this candidate.

## Rollout boundaries

0013_inventory_review.sql is new and unapplied. It adds review overlays and idempotent operations, separately from media inventory and capture jobs. This worktree does not include capture-job migration 0012. Before rollout, review and apply this migration to the correct existing database, then publish the Worker and matching frontend together using the established embedded-worker packaging workflow. Preserve actual deployment bindings, access policy and the closed ingestion gate. Database migration, deployment, producer integration and live ingestion each remain outside this local task.

Browser file grants and object URLs remain local and ephemeral; reload requires reselecting synced media, while saved notes and decisions return from the authenticated API. Review state is stored in D1 rather than Syncthing producer JSON. Browser QA uses synthetic media and mocked API persistence; SQLite tests separately verify storage, filtering, authentication and concurrency. Actual OS picker interaction, real episode codecs and production D1 rollout are not validated here.

## Local validation

npm run check verifies generated schema, lint, types, tests, frontend build and Worker dry-run packages. npm run test:browser runs existing hosted-style fixture regressions. security-review/local-playback-regression.mjs and inventory-review-regression.mjs exercise installed Chrome desktop/mobile and Firefox without an HTTP listener or real media. Python adapter tests are offline and do not scan live content.

Validated on nixvader, 2026-10-13: aggregate 836 tests in 35 files plus lint, types, schema freshness, frontend build and two Worker dry-run packages; 15 SQLite review tests included; 161 existing browser assertions; 17 persistence/row-review assertions per desktop Chrome, mobile Chrome and Firefox; six offline adapter tests. Desktop/mobile screenshots were visually inspected. Independent source review verified the corrected duplicate-identity filters, atomic save conflict guard and busy-input protection, with no remaining blockers in its focused follow-up.
The final playback lifecycle rerun also passed 23 assertions each on desktop Chrome, mobile Chrome and Firefox.
