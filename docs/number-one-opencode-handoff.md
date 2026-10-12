# Next Nomad change: durable, disabled inventory envelopes

The supplied v2 prototype has now been reviewed. Continue with the focused
[parity-fix task](number-one-parity/FIX-PROMPT.md); the original task below remains
the transport/durability specification.

Continue the separate TWiB inventory-bridge prototype in the Nomad repository.
Read repository/runbook instructions and the existing bridge handoff first.
Fetch the exact receiver commit using `docs/number-one-github-workflow.md`; read
`docs/number-one-inventory.md`, both schemas under `apps/worker/src/inventory/`,
and `apps/worker/test/fixtures/inventory.envelope.example.json` from that revision.
Implement and test the transport preparation described below without connecting,
activating or modifying any production service. The dashboard receiver is only a
local, hard-disabled implementation; no live ingestion endpoint or credential is
available. Preserve existing user changes and the read-only collector.

## Exact transport contract agreed with the receiver implementation

The v1 manifest schema/content stays unchanged. A usable partial scan (collector
exit 2, snapshot.complete=false) still gets an envelope; only a failed scan with
no usable manifest (exit 1) does not. Wrap each new usable scan in
an object with exactly these fields:

- schema: `number-one-inventory-envelope/v2`
- scan_id: a newly allocated lowercase UUIDv4, `str(uuid.uuid4())`
- sequence: monotonically increasing integer, 1 through 9007199254740991, scoped
  to the manifest's exact source_id and episode.id
- manifest: the complete unchanged `number-one-twib-inventory/v1` JSON, including
  observed_at, scan_finished_at and idempotency_digest

Proposed future request: POST `/api/v2/number-one/inventory-snapshots`, JSON,
Idempotency-Key equal to scan_id exactly, without a prefix. Do not configure a
hostname or make requests now. Both the old v1 route and proposed v2 route are
hard-disabled on the receiver.

A fresh scan always has a new scan_id and greater sequence, even when its content
digest repeats. A retry must reuse the exact immutable envelope, with the same
scan_id, sequence, timestamps and content. Do not recompute scan timestamps on
retry. Source clock changes must not control ordering.

The receiver orders each item's latest observation by sequence. Delayed older
sequences are accepted as history without rollback. Gaps are allowed. Reusing a
scan_id with changed envelope fields or reusing a sequence with another scan_id
returns 409. Reusing a content digest for different semantic content also returns
409. The receiver treats the Python digest as opaque and separately fingerprints
semantic content excluding the two scan times and digest. It fingerprints the
entire envelope separately, including times and sequence.

## Durable local preparation

Use a single logical writer per source/episode with private durable state outside
all production source/media trees. Prefer Python's standard-library SQLite: one
transaction allocates the next counter and stores the immutable outbound envelope.
Ensure private permissions, no symlink escapes, explicit episode selection,
bounded input and a bounded queue. No automatic deletion of acknowledged or
unacknowledged entries; report a full queue and stop allocating until an approved
retention policy exists. Document the chosen bound.

Crash/restart must resume the persisted envelope. Counter allocation and envelope
persistence must be atomic before any eventual network send. Do not silently reset
or initialize state for a stream that might already exist. Missing/corrupt/reset
state must stop with a sanitized actionable error; no guessed sequence, wall-clock
sequence or random epoch fallback. Fresh stream initialization must be explicit.
Operator recovery from an authenticated receiver high-water/reconciliation path
is future work; that endpoint is not available. Do not fabricate one.

Keep transport/network submission disabled or stubbed. Implement an offline
receipt-validation function only. A durable receipt has schema
`number-one-inventory-receipt/v2`, source_id, episode_id, digest, scan_id, sequence,
receipt_id, accepted_at, stored_item_count, complete, scope,
allow_deletions=false and candidate_coverage=partial. Only a matching source,
episode, digest, scan_id and sequence can acknowledge the corresponding queue
entry. A generic 2xx/202, timeout, unrelated receipt or changed envelope cannot.
Acknowledge only that entry; a higher receipt does not acknowledge skipped entries.
Stop/quarantine 401/403/409/schema failures in future sender logic; do not build an
unbounded retry loop or restart the producer.

## Receiver limits and privacy compatibility

- Entire serialized envelope at most 1 MiB uncompressed, 2,000 items
- At most 32 KiB serialized per item; 100 observations/origins/evidence per item
- At most 4,000 characters per string, 1,024 per relative ref, 2,048 per origin URL
- Depth at most 16; finite and safely representable numbers
- Unique item IDs, exact source/show/episode binding, valid ordered scan times,
  no more than five minutes future skew when eventually submitted
- ready=false and allow_deletions=false always; candidate coverage remains partial

Tighten the collector's safe URL/ref checks for the demonstrated bypasses:
trailing-dot localhost/private IP hosts, alternate numeric IPv4 hosts, controls,
URI/drive references and encoded traversal. Preserve useful notes and provenance;
do not claim arbitrary unlabeled secrets can be recognized. Origin hosts and
editorial privacy policy remain explicitly reviewed receiver configuration, not
permission for network access. Flag privacy/limit failures without dropping items
silently or asserting complete=true. Do not mutate producer media/state.

## Required offline tests and deliverable

Use synthetic fixtures only. Cover unchanged-content successive scans; exact
immutable retry; A→B→A with repeated digest/new sequence; equal or reversed source
clocks; delayed old sequences; allocation/restart/crash boundaries; competing
writers; counter/queue bounds; missing/corrupt state; wrong source/episode/digest/
scan_id/sequence receipt; duplicate sequence; and tightened URL/ref handling.
Use a local fake receiver, not the live dashboard or MCP probe.

Return the exact schema/example envelope, outbox/receipt contract, code diff,
test commands/results, remaining blockers and a reviewed diff. When separate
publication approval covers the Nomad repository, use an isolated feature branch
and draft PR with an exact commit SHA; no ZIP is required.
No credentials, grants, media uploads, live submissions, scheduling/Nix activation,
producer commands, service changes, commit or push are authorized by this prompt.
