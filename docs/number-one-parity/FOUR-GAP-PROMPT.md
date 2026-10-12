# OpenCode: close the four disabled-bridge parity gaps

Continue the existing **disabled** Number One inventory bridge in the Nomad source
repository. Read its repository/runbook instructions and preserve unrelated work.
Use the exact receiver revision linked in the current dashboard draft PR, following
`docs/number-one-github-workflow.md`. Read this directory's `PARITY-REVIEW.md`,
`regression-results.json`, `regression-fixtures/`, and
`reference-policy-vectors.json`; receiver tests are in
`apps/worker/test/inventory-parity.test.ts`.

The historical review passed 38 producer tests, 71 focused receiver tests and an
actual Python → TypeScript/SQLite → Python receipt roundtrip. It nevertheless
found these four bounded defects. Fix them with synthetic regression tests. Do not
alter the v2 envelope/receipt ordering protocol, relax privacy guards to make bad
fixtures pass, change unrelated producer jobs or media-processing behavior, or activate a sender.

## 1. Restore source/state confinement first

`outbox.roots` permits double-leading-slash aliases to bypass lexical overlap
checks on Linux. A synthetic state path `//.../source/state` can create the SQLite
outbox inside the protected source. Reject or consistently normalize leading
separator aliases **before** both-direction containment tests and durable binding.
Retain component-by-component no-follow opens. Unrestricted resolve() must not
replace symlink rejection. Existing bindings must fail closed rather than silently
rebind. Test double-leading-slash state and source roots, reversed containment,
normal non-overlap, symlinks, and existing-state reopening. Assert no source write.
All bypass probes must use fresh synthetic trees, never a live producer directory.

## 2. Match deliberate literal-reference safety

The receiver now accepts benign percent-bearing literal names without rewriting
references or identities. Implement the shared vector policy in
`inventory_safety.py:safe_relative_ref` and collector/preflight paths:

- Treat refs as exact literal names, not URL-encoded transport paths.
- Check raw text and every decoded view, through at most six decoding transforms.
- Reject traversal, absolute/URI/drive forms, Unicode Cc/Cf/Cs controls, recognizable
  secrets, and introduced slash/backslash separators in any view.
- Malformed/bare percent signs in refs are literal. Decode valid triplets even in
  mixed strings; `token%3DSYNTHETIC%zz.mp4` must not evade the secret check.
- Reject invalid UTF-8 escapes and still-decodable triplets beyond six transforms.
- Preserve accepted raw strings, e.g. `clip%.mp4`, `clip%25.mp4`, `clip%zz.mp4` and
  `clip%41.mp4`. Never normalize/decode stored IDs or actual filesystem names.

Use `reference-policy-vectors.json` directly as shared assertions. The receiver's
original blanket percent rejection is already fixed in this receiver revision.
The supplied `percent_filename.json` should now validate; encoded-secret fixtures
must remain rejected. Diagnostic redaction still cannot recognize arbitrary
unlabeled secrets. Do not claim complete redaction.

## 3. Align origin URI syntax and reserved-host checks

Keep URL origins distinct from literal filesystem refs. Reject malformed percent
escapes and reserved/nonpublic suffixes including .localhost, .local, .internal,
.lan, .home, .test and .invalid. Use valid public HTTP(S) syntax; preserve existing
rejections for userinfo, ports, numeric/IP aliases, unsafe decoded paths and
credential-bearing values. The original collector accepts both .home and `%zz`
URL fixtures even though the receiver rejects them. Align `public_url` and
`bridge_contract.py` URI validation with the pinned schema/receiver tests.
Removing an unsafe origin must preserve truthful partial/error reporting, not
silently manufacture a complete transport-ready scan. Do not resolve or contact
any host. Approved origin hosts and prose policy still need separate authorization.

## 4. Complete prepare-manifest preflight

Receiver guards apply to arbitrary `prepare --manifest` input too, not only output
that happens to be constructed consistently by the collector. Enforce all array
bounds, coverage/warning counts, warning syntax and item kind/status/presence/
capture-evidence invariants before allocating a sequence or outbox entry.

In particular, 2,005 warnings and 2,001 coverage rows must fail preflight without
allocation. Do not silently truncate evidence to appear sendable. Keep useful local
diagnostics explicitly unqueueable, or introduce only an agreed fixed sanitized
aggregate warning with partial status. `receiver_rejected:UPPERCASE_CODE` is not an
accepted manifest warning namespace. The four `prepare_*` fixtures exercise this
separate input path. Keep these invalid envelopes rejected.

## Verification and return

Run the existing producer suite plus regressions for all four groups. Verify
source-copy checksums remain unchanged except for your explicit reviewed edits;
show a focused diff. Re-run real receiver validation with the exact pinned
receiver revision, including both schemas and semantic checks. Show the benign
percent case accepted unchanged and all eight other original negative envelopes
still rejected (or rejected safely by producer preflight before allocation).
Recheck restart/crash durability, competing writers, immutable retry, A→B→A,
clock reversal, delayed arrival, partial omission retention and receipt matching.

Return exact revisions, code/test paths, commands/results and remaining blockers
through the agreed GitHub workflow. Publish Nomad changes only within separately
approved repository scope; otherwise return a reviewable diff. No ZIP is required.
Do not include live manifests, private paths, credentials, SQLite state, logs or
media. No live network submission, auth provisioning, source/media mutation,
scheduling/Nix activation, production migration, merge or deployment is authorized
by this fix prompt.
