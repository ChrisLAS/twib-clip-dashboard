# Recognizable-secret policy v1

Normative shared input: `secret-policy-vectors.json`. All values are synthetic;
none are usable credentials. This is a bounded heuristic, not a guarantee of
complete redaction. Existing reference, URL, prose and schema guards still apply.
A detector-negative string is not automatically safe to ingest.

## Exact language-neutral detector

Search the original text without Unicode normalization or percent decoding. The
caller supplies each required raw/decoded view according to its existing policy.
Fold only ASCII A–Z to a–z, preserving indices. A match may start at the beginning
or immediately after a character outside ASCII `[a-z0-9_]`. Thus `étoken=...`
matches but `mytoken=...` does not. There is **no right-boundary requirement**.
Do not use a language's default `\b`, Unicode case folding, `\s`, or `\S`.

Whitespace W is exactly these Unicode code points (inclusive ranges):
`0009–000D, 0020, 00A0, 1680, 2000–200A, 2028, 2029, 202F, 205F, 3000, FEFF`.
This pins the receiver's existing ECMAScript whitespace semantics. U+001C and
U+0085 are not W; independent field control-character guards remain unchanged.
A value V is one or more consecutive characters outside W. Quotes, commas,
semicolons and brackets **are value characters**, not evidence of an empty value.

At the left boundary, recognize any of these alternatives after ASCII folding:

1. `bearer` or `basic`, then one or more W, then V.
2. A label, optionally one ASCII single/double quote, zero or more W, `:` or `=`,
   zero or more W, then V. For match extent, prefer an optional ASCII quote,
   `bearer`/`basic`, one or more W and V over plain V; consume the scheme and its
   following credential together, including a closing quote as part of V. Labels: `token`, `secret`, `password`, `authorization`,
   `signature`, `access[_-]?token`, `refresh[_-]?token`, `client[_-]?secret`,
   `api[_-]?key` (the `[_-]?` notation means zero or one underscore or hyphen).
3. `eyj` followed by one or more `[a-z0-9_-]`, a dot, one or more of that class,
   another dot and one or more of that class.
4. `gh` then one of `pousr`, underscore and one or more `[a-z0-9_]`.
5. `sk-` and at least 16 `[a-z0-9_-]` characters.

No labelled placeholder exemption exists: `token=[redacted-secret]` and
`token="[redacted-secret]"` reject, as does `token="".mp4`. A standalone
`[redacted-secret]` is detector-negative. This removes an ambiguous legacy
negative-lookahead exemption rather than weakening privacy rejection.

## Producer redaction and validation

Use one shared detector/match implementation in both the collector redactor and
validator. Do not duplicate regexes. Redact the entire recognized match to the
standalone marker `[redacted-secret]`, preserving a preceding boundary character.
Run the shared detector over redacted output again; no recognized match may remain.
Do not log matched raw text. Identity construction must use existing safe/redacted
inputs; never decode or rename actual files. Unsafe filesystem refs must be omitted
with truthful partial diagnostics or rejected before sequence allocation. Origins
and prose must be safely removed/redacted with truthful diagnostics or rejected;
never label an unchanged unsafe payload transport-ready.

## Bounded evidence

[Nomad PR 13](https://github.com/ChrisLAS/nomad-nixos/pull/13) revision `b60b633f779a61ddba38d05cfd32cb46a4c75e99` passed 46 producer tests, the original parity cases,
and an offline Python → TypeScript/SQLite → Python receipt roundtrip. Nevertheless,
six actual synthetic collector scans were marked complete and durably queued, then
rejected by receiver `e412f21ec4b36291e9357a6929b7d5fb32b873c2`:

- Refs: `étoken%3DSYNTHETIC.mp4`, `étoken=SYNTHETIC.mp4`,
  `éghp_SYNTHETIC.mp4`, `token="".mp4` → `INVENTORY_UNSAFE_REFERENCE`.
- Origin: `https://example.com/%C3%A9token%3DSYNTHETIC` → `INVENTORY_UNSAFE_URL`.
- Title: `étoken=SYNTHETIC` → `INVENTORY_PRIVACY_REJECTED`.

These six input/call-site assertions, 56 detector cases and seven redaction-span cases are in the JSON corpus,
consumed directly by `apps/worker/test/inventory-secret-policy.test.ts`. The
receiver keeps all six rejections. This corpus closes the known detector mismatch;
it is not an invitation to expand fuzzing or redesign the bridge. Nomad's four red
repository-wide CI checks are a separate unresolved result; the review did not
prove they predated the patch. No live Nomad service or authenticated HTTP receipt
has been verified, and the receiver routes remain hard-disabled.
