# Number One inventory bridge v2: local cross-language review

Reviewed 2026-10-12. Scope: supplied Python collector/outbox handoff against the local dashboard receiver corresponding to PR #2, supplied receiver commit `348d57dcc8fa84c3b78f37474470c348ab44c0cf`. This historical review did not independently fetch the remote commit or CI. No live Nomad runtime, production source, sender, credentials, grants, deployment, or production migration was exercised.

## Publication note

This report records the original supplied-producer review against receiver commit
`348d57dcc8fa84c3b78f37474470c348ab44c0cf`. The follow-up on this PR fixes only the
receiver's unnecessary rejection of benign percent-bearing literal references.
`reference-policy-vectors.json` and `apps/worker/test/inventory-parity.test.ts`
now specify the agreed six-pass inspection policy. `regression-results.json`
is deliberately preserved as **historical baseline evidence**: its percent-filename
rejection is no longer the expected current outcome. All eight other negative
fixture envelopes must still reject. Read `FIX-PROMPT.md` for remaining producer
work. No producer implementation is published or modified by this change.

All distributed fixture filenames, URLs, IDs and media-shaped data are synthetic.
`SYNTHETIC` in encoded-secret tests is a placeholder, not a usable key or secret.
No live paths, machine credentials, producer state or media are included.

## Verdict

The durable-writer and normal interoperability foundation passes. Authentication design can proceed independently, but the producer/receiver preflight policy is not fully aligned. Keep transport disabled. Four bounded fix groups below are gates before live sender activation. These are potential privacy/availability defects, not evidence of a live disclosure: there is no active sender and the receiver rejects every reproduced bad envelope.

## Verified positives

- ZIP SHA-256: `5532f8e210d860b8a6cd516f40c0fa7a0b06a526db69c21672a98998b2d1cd19`.
- 26 ZIP entries, 245,817 expanded bytes; no absolute/traversal/backslash paths or symlinks. CRC validation and all 25 bundled SHA256SUMS entries pass.
- Both manifest v1 and envelope v2 JSON schemas are byte-identical to receiver copies.
- Producer: 38/38 bundled unittest tests pass. Includes real child-process exits before/after SQLite transaction commit, competing writers, restart/export identity, state corruption/reset refusal, private permissions, bounds, redaction and path escapes.
- Receiver: focused `inventory.test.ts` suite passes 71/71.
- Actual Python collector and durable outbox -> actual TypeScript `acceptInventory` and all migrations on in-memory SQLite -> real durable receipts -> Python receipt validator and durable offline acknowledgments passes. This is not merely the bundled FakeReceiver.
- Cross-language A -> B -> A has sequences 1,2,3, repeated A digest, backward A clock and reverse arrival. Latest stays sequence 3. Partial empty sequence 4 preserves prior item. Exact retries return original receipts; changed scan/sequence conflicts reject; missing grant rejects.
- Actual receiver receipt roundtrip accepts repeated identical acknowledgment and rejects stale receipts for another scan, including repeated-content A. Supplied static example also passes actual receiver and Python receipt validation.
- Real collector CLI with malformed synthetic sidecar exits 2 and emits usable partial; outbox prepare successfully durably queues it. Failed scans are tested not to allocate.

## Fix group 0: source/state path confinement (highest priority)

On Linux, a path with two leading slashes refers to the same filesystem tree as a single-leading-slash path, but pathlib preserves the double slash in lexical comparisons. `outbox.roots` compares Path.is_relative_to before rejecting/canonicalizing this alias. With a synthetic source `/tmp/.../source` and state `//tmp/.../source/state`, initialization succeeds and creates `outbox.sqlite3` inside the protected source tree. No symlink, race or privileged attacker is required.

Risk: accidental source-tree mutation/pollution and violation of the explicit private-outbox-outside-producer/media guarantee. No real producer tree was used in the reproduction. This is higher priority than a receiver rejection because the local filesystem boundary itself is bypassed.

Minimal fix: reject or consistently normalize leading-separator aliases before both-direction overlap checks and before persisting the root binding. Retain component-by-component no-follow opens; do not use unrestricted resolve() as a substitute for symlink rejection. Add tests for `//source/state`, `//source` as allowed_root, and reversed containment. An existing bound state must fail closed rather than silently rebind under changed normalization. Include cross-platform path semantics explicitly if supporting systems beyond Linux.

## Fix group 1: relative-reference policy and encoded privacy checks

Repro fixtures: `regression-fixtures/percent_filename.json`, `encoded_secret_filename.json`.

Actual collector over synthetic media filenames `clip%25.mp4` and `token%3DSYNTHETIC.mp4` produces `complete=true`; `Outbox.prepare` commits sequence 1. Actual receiver rejects both with 422 `INVENTORY_UNSAFE_REFERENCE`.

Two different cases must not be conflated:

1. A literal percent-bearing filename is legitimate filesystem data. The first failure comes from receiver `safeRef` rejecting every remaining `%` after one decoding pass. Do not blindly copy this rejection into the collector.
2. The second filename contains a recognizable labeled secret after decoding. Producer `safe_relative_ref` checks traversal/controls on raw and decoded strings but tests SECRET/OPAQUE only on raw text (inventory_safety.py:48-54). The potentially sensitive encoded reference can be exported before a future receiver rejects it. Heuristic redaction is not a complete privacy guarantee.

Recommended unified policy: refs are exact literal relative filesystem names, not URL-encoded transport paths; preserve their raw bytes/text for identity. Check raw and bounded-decoded views for unsafe traversal, separators, URI/drive/control forms and recognizable secrets; never silently decode the actual name. Permit benign literal percent names where there is no unsafe interpretation. Adjust receiver's blanket decoded-percent rejection to that deliberate policy, rather than simply loosening all escape checks. Add shared test vectors for literal `%` and `%25`, encoded separators, nested traversal, malformed escapes and encoded secrets. Agree malformed-ref escape treatment explicitly; URL-origin validation remains a different rule.

Minimal locations: producer inventory_safety.py:safe_relative_ref and collector safe_ref; receiver contract.ts:safeRef; shared differential fixtures. No need to alter ordering, outbox storage or receipt protocol.

## Fix group 2: public-origin syntax and reserved-host parity

Repro fixtures: `reserved_origin.json`, `malformed_percent_origin.json`.

Actual collector accepts `https://media.home/path` and `https://example.com/clip%zz`, marks both complete and durably queues them. Actual receiver rejects the former with 422 `INVENTORY_UNSAFE_URL` even with media.home explicitly included in a synthetic grant; the latter fails the actual compiled envelope URI validation (`INVENTORY_ENVELOPE_INVALID`).

Recommended unified rules: valid public HTTP(S) URL syntax and percent escapes; reject reserved/nonpublic suffixes consistently (.localhost/.local/.internal/.lan plus receiver .home/.test/.invalid). Producer sanitization must flag a partial scan when it removes these origins and must not emit a locally declared valid envelope that fails the pinned schema URI format. Exact approved host allowlist remains a separate future grant/privacy policy, not something inferred from a public-looking hostname.

Minimal locations: producer inventory_safety.py:public_url and bridge_contract.py schema_check URI branch; preserve receiver's public-host restriction. Add differential URI vectors using the receiver's compiled schema. Do not contact or resolve these hosts.

## Fix group 3: complete receiver-preflight limits and invariants

Repro fixture: `warning_limit.json`.

2,001 synthetic skipped symlinks produce 2,005 warnings and no items. Collector correctly marks the scan partial, but producer validator and outbox accept it, while receiver returns 422 `INVENTORY_LIMIT`. Producer only bounds items/evidence arrays, whereas receiver bounds every array and explicitly caps coverage/warnings at 2,000.

Minimal fix: enforce receiver array/count policy in producer bounded_tree/validate_manifest before outbox allocation. Preserve diagnostic local output if useful, but explicitly classify oversized output as unusable for transport. Do not silently truncate evidence or warning lists to manufacture a sendable complete scan. If warning aggregation is intentionally introduced, use fixed sanitized aggregate warning codes and retain partial status.

Also align producer preflight for receiver warning-code syntax and item kind/status/presence/evidence consistency. The actual collector normally constructs these consistently; arbitrary `prepare --manifest` input is a distinct path and must not be claimed receiver-compatible solely because schema validation passed. Collector diagnostic `receiver_rejected:UPPERCASE_CODE` is not a receiver-approved warning format; such diagnostics should remain explicitly unqueueable, or use an agreed sanitized warning namespace. These findings do not justify weakening receiver validation.

## Portable verification commands

Use the reviewed producer bridge directory and a checkout of the exact receiver
commit linked from the current draft PR. Do not use a moving branch tip.

From the producer directory, the original review ran:

    sha256sum -c SHA256SUMS
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -v

The supplied producer tests require `/tmp/opencode` as their synthetic temporary
parent. This is a test portability detail, not a production path or state binding.

From the receiver repository root:

    ./node_modules/.bin/vitest run apps/worker/test/inventory-parity.test.ts apps/worker/test/inventory.test.ts apps/worker/test/inventory-runtime.test.ts

Historical differential reproduction, with an existing reviewed producer checkout,
installed receiver dependencies and a fresh output directory outside both trees:

    PYTHONDONTWRITEBYTECODE=1 python3 docs/number-one-parity/reproduce_edges.py --producer "$PRODUCER_DIR" --receiver "$RECEIVER_DIR" --output-dir "$NEW_SYNTHETIC_OUTPUT_DIR"

The reproduction script does not install packages or use network. It intentionally
fails rather than reuse an existing output directory. All intentional confinement
violation probes run only against synthetic trees beneath that directory. Read the
script before running it against an independently supplied producer checkout.

`regression-results.json` preserves nine producer-accepted/receiver-rejected
baseline cases, the synthetic source-boundary bypass, and a passing receipt-reuse
control. Five rejection cases came from actual collector scans and four from the
separate prepare-manifest input path. After the receiver fix, the benign percent
case is accepted unchanged; the other eight stay rejected. A corrected producer
may reject some inputs earlier, so this historical reproducer is diagnostic, not
a pass/fail oracle for future producer versions. The producer fix should include
new automated assertions for safe rejection and non-allocation.

The original full roundtrip used custom local harnesses to pass real Python
collector/outbox envelopes through TypeScript acceptance with disposable SQLite
and returned actual receipts to the Python validator. Those temporary harnesses,
compiled bundles, databases and logs are not part of this public handoff; the
positive results above describe what was observed, not additional runnable files.

## Limits and remaining approvals

A full `npm test -- --reporter=dot` rerun was attempted, but its runtime requested registry.npmjs.org access and the action reviewer blocked it under the no-network constraint. No network retry was made. Its incomplete log is not a pass. The previously reported 536 green CI tests are prior evidence only; this review newly verified 71 focused receiver tests, 38 producer tests and the custom offline differential/roundtrip harnesses. No new actual workerd/D1 runtime verification is claimed.

Authentication, receipt authenticity, source/episode registration and workspace mapping, exact host/editorial privacy policy, 64-entry retention/reconciliation, rollout and sender scheduling remain separate design/approval work. Old correctly bound receipts are intentionally replayable evidence; freshness of machine authentication is a future adapter concern. Offline acknowledgment explicitly is not proof of an authenticated server.

## Receiver follow-up verification

The receiver-only literal-percent correction was checked separately after this
historical review. `npm run check` passed locally: 29 test files, 572 tests, lint,
TypeScript checks, frontend build and both Worker dry-run bundles. The focused
inventory set has 108 checks: 71 original unit/SQLite cases, 36 parity/vector cases
and one actual workerd/D1 runtime test. The nine historical fixtures remain
byte-identical; one benign-reference outcome intentionally changes to acceptance,
and the other eight remain rejected. No producer source was edited or re-executed
for this correction. Hosted results for the new commit are recorded in PR #2.
