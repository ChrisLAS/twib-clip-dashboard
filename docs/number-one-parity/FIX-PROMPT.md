# Archived task: align the shared secret detector

The original mismatch is closed in the reviewed producer. Current work is the
[disabled manual sender task](../number-one-pilot-opencode.md), including the
subsequent `cfast_` corpus extension. The text below is historical.

Continue the existing disabled Number One inventory bridge from reviewed Nomad
PR 13 revision `b60b633f779a61ddba38d05cfd32cb46a4c75e99`. Read repository instructions; preserve unrelated work.
Fetch the exact receiver commit linked in the current dashboard draft PR using
`docs/number-one-github-workflow.md`. Read this directory's `secret-policy.md` and
`secret-policy-vectors.json`; they define the bounded task and exact shared policy.
The earlier four-gap prompt is archived in `FOUR-GAP-PROMPT.md`: its original
regressions now pass. Do not redo or broaden that work.

## Required change

Replace the divergent Python Unicode-boundary/quoted-value detectors with one
shared implementation matching `secret-policy.md` exactly. Both collector
redaction and `inventory_safety.py` validation must call it. Explicitly pin ASCII
left boundary and ASCII-only case folding, the enumerated whitespace code points,
non-whitespace value semantics including quotes/punctuation, opaque token patterns,
and standalone versus labelled redaction-marker behavior. Do not use global
`re.ASCII` as a substitute: it changes whitespace semantics. Do not loosen the
receiver to accept the six unsafe collector outputs.

Consume the JSON detector corpus directly in Python tests; do not maintain a
second manually copied expected-results list. Consume the full expected redaction
outputs too: assignment values such as `authorization="Bearer SYNTHETIC_VALUE"`
must remove the scheme and credential together, never leave an orphaned value. Reproduce its six integration cases
through actual synthetic collector scans and outbox prepare, not merely helper
calls. Each unsafe original must be rejected before allocation or safely omitted/
redacted with truthful partial diagnostics. No emitted/queued envelope may retain
its recognizable secret. Revalidate every emitted envelope with the exact pinned
receiver and both schemas. Check that redaction output passes the shared detector,
that the marker is stable on a second pass, and that diagnostics contain no raw
matched text. Existing reference decoding and strict origin-URI policy stay intact.

## Verification and return

Run all producer tests and these bounded regressions. Keep the original nine
parity fixtures, 27 reference vectors and offline durable-receipt roundtrip green.
Retain existing ordering/retry/restart/partial-retention tests. Return exact head
SHA, focused changed files, test commands/counts and synthetic cross-language
results through the approved GitHub workflow; no ZIP or live data is needed.

Report the four currently failing repository-wide CI checks separately. They are
outside this bridge patch and have not been proven pre-existing. Do not change
unrelated code or global CI merely to make this task green.

Do not activate a sender, schedule/Nix service, provision auth, write producer/media
files, mutate durable live state, merge, deploy or apply production migrations.
The receiving HTTP namespace stays hard-disabled. This prompt authorizes only the
bounded patch within the separately approved Nomad repository workflow.
