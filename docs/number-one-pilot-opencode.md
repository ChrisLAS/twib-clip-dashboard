# OpenCode: prepare the disabled manual inventory sender

Continue the reviewed Nomad inventory bridge on its existing PR, starting from
`2bf06a7d86c314328f33d723fcc66a8f87a7789c` (PR 13). Read repository
instructions and preserve unrelated changes. Fetch the full receiver SHA linked
in the dashboard draft PR using `docs/number-one-github-workflow.md`, then read
`docs/number-one-pilot.md`, the v2 schemas and this bounded task. Do not activate
network submission, change host services or install any real credential as part
of this implementation-only handoff.

## Shared privacy projection and credential detection

Consume the receiver's current `docs/number-one-parity/secret-policy-vectors.json`
directly in Python tests (currently 80 receiver assertions across detector, exact
redaction and integration cases). Add `cfast_[a-z0-9]{48,}` under the existing ASCII
boundary/case policy; redact the entire alphanumeric run, including overlong
suffixes. Fixtures are synthetic. Keep the previously fixed detector grammar and
original parity tests. Do not weaken privacy or broaden fuzzing.

Add an explicit metadata-only preparation mode: origins=[] and every observation
context={}, before content digest calculation and durable envelope allocation.
Keep item IDs and relative refs exactly, retain other validated metadata and emit
sanitized truthful omission diagnostics; policy omissions mean complete=false.
Never edit already queued envelopes. Run normal schema/semantic preflight before
sequence allocation. Pending envelopes from the older mode need explicit operator
reconciliation, not silent rewriting, skipping or stream reset.

## Disabled, one-shot HTTPS sender

Implement a manual command with no scheduler/background loop. A separately
provisioned explicit activation flag must default false; absent/false must stop
before reading the credential file or making any network request. The mere
presence of the manual command must not enable transport. Test this offline. Its configured
receiver must be one exact operator-approved HTTPS origin and
`/api/v2/number-one/inventory-snapshots`, no query/fragment/userinfo/custom port.
No arbitrary destination override per request. Standard TLS/hostname verification
is mandatory; disable redirects entirely, including same-origin redirects.
Do not make live requests in tests.

Read the one service Client ID and Client Secret from a separately provisioned
private credential file outside producer/media and durable envelope data. Use
no-follow file opens, verify a regular owner-owned file with restrictive mode,
bounded size, reject symlinks/unsafe ownership/permissions, and never create or
chmod a real credential file during this task. Do not accept secrets in arguments,
inline env values, checked-in config, URLs, stdin prompts captured by logs or
outbox payloads. Use the same credential for pilot and subsequent approved use;
no test/production/weekly token generation. Runtime memory need only hold it for
the request. Tests use dummy temporary files, not real credentials.

POST the exact persisted immutable envelope bytes with application/json,
Idempotency-Key=scan_id, CF-Access-Client-Id and CF-Access-Client-Secret headers on
each request. Do not send cookies, Authorization fallbacks or extra metadata.
Bound connect/read/overall timeouts and response bytes (maximum 16 KiB).
Request identity encoding and reject compressed responses; never decompress an
unbounded response. Require an application/json response content type. No verbose
HTTP tracing; logs/errors must contain only bounded status/error codes and safe
identifiers, never headers, secrets, body, private paths or arbitrary response text.

Treat only HTTP 200 plus valid JSON v2 durable receipt as potential success. Match
source_id, episode_id, scan_id, sequence, digest and stored_item_count to the exact
queued entry; validate all remaining receipt invariants using the existing receipt
validator before durably acknowledging that entry. No ACK from generic 2xx/202,
HTML/login pages, redirect, oversized/malformed response, wrong receipt or network
failure. Keep offline import/ACK clearly distinct from authenticated send evidence.
On uncertain network failure retain the envelope unchanged and permit deliberate
exact retry. Stop on 401/403/409/validation errors; never allocate a new scan to
paper over failure. No unbounded retries or automated queue drain.

## Pilot preparation, tests and return

Provide offline preparation/review support for the manual sequence in
`number-one-pilot.md`: one zero-item incomplete snapshot using the existing
stream's next sequence, exact replay, then one reviewed real episode-127 projected
snapshot and stop. No second test stream, state reset, guessed high-water mark,
retention pruning or more than existing 64 retained entries including ACKed.

Use offline transport fakes to test exact destination/bytes/headers, no redirects,
TLS defaults, secure file checks, timeouts/response limits, redacted error paths,
strict receipt matching/durable ACK and unchanged retry state. Run all bridge tests,
shared corpus, original parity and offline Python→receiver/SQLite→Python roundtrip
against the exact pinned receiver. Return exact commit/diff, test commands/counts
and remaining activation gates in the existing approved draft-PR workflow.

Do not create tokens, change Access/security settings, contact the live endpoint,
apply migrations, deploy, merge or activate a Nix/systemd/timer service. Global
Nomad CI failures outside this patch remain separately deferred; do not expand this
patch to fix them. The user will approve exact live access/provisioning and manual
pilot changes separately after both implementations are reviewed.
