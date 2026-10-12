# Number One inventory receiver (local, disabled)

This is a metadata-only foundation using an immutable v2 transport envelope around
the unchanged `number-one-twib-inventory/v1` manifest. It is not
connected to Number One, not deployed, and not a sender. The existing MCP probe
is unrelated and cannot ingest inventory. No new credentials, Access rules,
services, schedules, media paths, or production database changes are included.

## HTTP and authorization boundary

- The exact POST `/api/v2/number-one/inventory-snapshots` has a separately scoped,
  disabled-by-default machine adapter. Missing private configuration returns 503;
  all v1/sibling reserved paths stay disabled. No activation values are tracked.
  See [the pilot contract](number-one-pilot.md) for exact config, JWT and grant checks.
- `acceptInventory` requires an explicit server-side `InventoryGrant` binding
  source, exact episode ID/number, inventory:write, expiry and privacy policy.
  Never construct it from unverified request JSON/headers. The pilot adapter fixes
  source/episode127 and rejects all origins/context before persistence.
- Owner Access, Drive OAuth, browser CSRF, demo and temporary MCP OAuth cannot
  construct a producer grant. Dedicated machine verification occurs before reading
  the bounded body. Owner routing/authentication remains unchanged.
- Owner-only `GET /api/inventory?episodeId=episode_<64 hex>&after=item_<64 hex>`
  exposes a read foundation, 20 identities per page. `after` is optional.
  Episode IDs belong to the inventory contract, not curated dashboard episode
  identifiers. No heuristic mapping to the active dashboard workspace occurs.
  No inventory UI is included in this foundation.

## Validation and privacy

The handoff manifest JSON Schema is copied byte-for-byte. A separate
`envelope.schema.json` defines the v2 wrapper and references the manifest schema by
its registered URN. Ajv 2020 plus ajv-formats compiles both at development time into a bundled standalone validator. This avoids Workers'
runtime `eval`/`new Function` prohibition. Run `npm run inventory:validator` after
schema changes; `npm run check` verifies the generated file is current. The code
validates date/time formats, unknown properties, conditionals, readiness=false,
and allow_deletions=false, rather than relying on the handoff's subset checker.

Additional receiver limits (stricter than the handoff proposals):

- 1 MiB uncompressed JSON, measured while streaming and again before storage
- 2,000 items; 32 KiB serialized per item; 100 observations/origins/evidence per item
- 4,000 characters per string; 1,024 per relative ref; 2,048 per origin URL
- Maximum structural depth 16; finite, safely representable numeric metadata
- Unique item IDs; exact recomputed source/show/episode ID; matching scan-ID header
- Ordered valid scan timestamps, at most five minutes ahead of receipt time

These limits accommodate the handoff's 48-item historical example while keeping
individual D1 rows below the 2,000,000-byte row limit. They are a proposed receiver policy,
not an assertion that the producer already implements or agrees to these limits.

Unsafe references, controls, traversal, encoded traversal, URI/drive paths,
userinfo, local/IP/non-approved hosts, non-YouTube queries, fragments, ports,
recognizable secrets and absolute host paths in prose are rejected with sanitized
422 error codes. The receiver rejects rather than silently rewrites content, so
idempotency comparisons preserve the exact approved metadata. Origins must have
an explicitly reviewed exact-host allowlist. Nonempty editorial context requires
an explicit privacy policy. Nothing resolves DNS, fetches URLs, reads media, runs
commands, retries downloads or controls producer jobs.

Relative refs are **literal filesystem names**. Preserve their original text and
IDs; decoding is inspection only. Raw text and up to six decoded views must all
avoid traversal, absolute/URI/drive forms, controls (Unicode Cc/Cf/Cs), recognizable
secrets and newly introduced separators. Reject valid escapes remaining beyond
that budget and invalid UTF-8 escapes. Bare/malformed percent signs in refs remain
literal, while valid triplets in mixed strings are still inspected. Benign `%`,
`%25`, `%zz` and `%41` filenames are therefore accepted unchanged. Origin URLs
remain a separate strict URI policy. Shared cases live in
`docs/number-one-parity/reference-policy-vectors.json`.

These checks cannot identify arbitrary unlabeled secrets in prose or URL paths.
An approved host is not proof that every path is public. A manual privacy review
of representative output and the concrete scope policy remains required before
activation. Do not claim the heuristic filter guarantees redaction.

## Storage and acknowledgment

Migration `0011_number_one_inventory.sql` adds three isolated tables:

- `inventory_snapshots`: immutable original manifest, semantic hash and receipt
- `inventory_items`: identities keyed by source, episode and producer item ID
- `inventory_observations`: immutable item evidence per accepted receipt

One D1 atomic batch inserts the receipt, upserts identities without replacement,
and inserts observations. Only a durable receipt read after the batch produces
success. A lost commit response can be reconciled safely. Equal concurrent
submissions receive the same committed receipt; conflicting reuse returns 409.
Partial/complete snapshots, absent artifacts, missing items, expired grants and
lack of contact never delete anything. Existing clip, render, review, editorial,
intake and publication tables are untouched. There is no retention cleanup job.

### Exact v2 envelope

Proposed route (not activated or approved):
`POST /api/v2/number-one/inventory-snapshots`.
Header: `Idempotency-Key: <scan_id>` (no prefix).
Body has exactly four fields:

- `schema`: `number-one-inventory-envelope/v2`
- `scan_id`: lowercase UUIDv4, e.g. Python `str(uuid.uuid4())`
- `sequence`: integer in 1..9007199254740991, monotonically allocated per source/episode
- `manifest`: the unchanged v1 manifest, including its content digest and scan times

A new usable scan receives a new scan_id and sequence even when its content digest repeats.
Usable partial scans (collector exit 2) are included; failed scans without a usable
manifest (exit 1) are not.
A retry reuses the immutable entire envelope, including original scan timestamps.
Exact/property-order-only retries return the original durable receipt. Reusing
scan_id with any changed field or sequence with a different scan_id returns 409.
The source/episode pair comes only from the inner manifest and verified grant.
Sequences need not be contiguous at the receiver: late queued scans and gaps are
allowed. IDs or counters from another source/episode do not share an ordering.

Treat the client digest as opaque. The receiver's separate SHA-256 over recursively
key-sorted JavaScript JSON excludes `observed_at`, `scan_finished_at` and
`idempotency_digest`. It is only a server equality check, not Python canonical
JSON or RFC 8785. Property-order/format changes preserve content identity, and fresh scans may
reuse that digest; changed semantic content under that digest returns 409.
Arrays retain their contract order. Client digest verification is not claimed.
A database trigger and scoped digest index reject different semantic content under
the same client digest, including concurrent distinct scan IDs. A separate envelope
hash covers **all** envelope fields, including scan times and sequence. The content
hash excludes scan times; the envelope hash deliberately does not.

The synchronous `number-one-inventory-receipt/v2` receipt contains schema,
source_id, episode_id, digest, scan_id, sequence, receipt_id, accepted_at,
stored_item_count, complete, scope, allow_deletions=false and
candidate_coverage=partial. The count means observations stored, not playable items
or a statement that every item became the latest. The eventual sender must match
source, episode, digest, scan_id and sequence exactly before recording an
acknowledgment. No asynchronous 202/polling protocol is implemented.

## Ordering and identity caveats

Latest state is derived per item from the greatest accepted **sequence**, never
source wall-clock time or receipt arrival time. Older queued scans are retained
without rolling back newer items. Equal timestamps and backward-moving source
clocks do not affect ordering. A → B → A works: the final A reuses the content
digest but has a new scan_id and larger sequence. Conflicting reuse of an existing
sequence is rejected rather than arbitrarily picking a winner. Partial snapshots
still preserve omitted items and all prior observations.

This protocol requires one logical, persistent writer per source/episode. Before
first submission, the sender must atomically persist its allocated next sequence
and immutable envelope in a private durable outbox **outside** the producer/media
tree. A process restart resumes the same envelope, not a freshly generated retry.
Lost/reset/unknown sequence state must stop sending; never guess a counter or use a
random epoch fallback. Recovery needs an operator-controlled authenticated
reconciliation/high-water mechanism, which is **not implemented or authorized** in
this foundation. A fresh source/episode initialization must be explicit.

Source timestamps remain display evidence with validity/future-skew checks.
Heartbeat/contact freshness is intentionally unimplemented and cannot be inferred
from receipt timestamps or playback readiness.

Producer IDs are preserved, not recomputed or merged by the receiver. Relative-path
media IDs change on rename. Redacted URL variants may already have collapsed
candidate identities upstream; the receiver cannot recover missing distinctions.
All metadata remains unverified for playback. `captured_observed`, `downloaded`,
`captured` and `ok` never promote media readiness.

## Verification and remaining activation work

The receiver tests use the exact synthetic handoff example and real in-memory
SQLite with all migrations, including foreign keys and transaction rollback.
They cover schema, scope, privacy, limits, idempotency, concurrent duplicate and
uncertain responses, partial snapshots, sequence ordering/conflicts, pagination, episode
isolation, durable rollback, disabled HTTP and owner-read authentication.
No supplied Python collector code is executed by these tests.

Before any live integration:

1. Agree source/episode registration, explicit inventory-to-workspace mapping,
   v2 durable-writer protocol, privacy policy, host allowlist, limits and retention.
2. Select and approve fresh machine authentication, resource scope, secure
   provisioning/storage and revocation. The local verifier is implemented/tested;
   no live policy or credential is configured.
3. Review production Access routing independently; owner access must remain intact.
4. Approve/apply migration and deployment, then test an approved synthetic snapshot
   end to end and unauthorized/wrong-source/episode/replay cases.
5. Separately approve a sender, scheduling and activation on Number One. Media
   delivery, complete discovery ledger and readiness remain separate work.

References: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/).

Local verification on 2026-10-12 additionally exercised the receiver in actual
workerd/D1 through a synthetic test-only harness: standalone schema validation,
transactional persistence, original receipt replay and digest conflict rejection.
That harness is not shipped as a production route.
