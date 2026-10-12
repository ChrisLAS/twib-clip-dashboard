# Number One: bounded authentication diagnostics

This is a diagnostic-only sender change. It does not authorize a submission,
credential change, policy change, new scan, reset, or automatic retry. Keep the
sender disabled and retain the existing immutable outbox entry. A separately
approved retry must use that exact entry, including its scan ID and sequence.

## Receiver contract

Authentication rejection remains HTTP 401, JSON, `Cache-Control: private, no-store`.
The existing fixed `error.code` is `INVENTORY_AUTH_REQUIRED`; the fixed message is
unchanged. An optional `error.category` is one of:

- `assertion_missing`
- `assertion_shape`
- `request_scope`
- `jwks_unavailable`
- `signature`
- `issuer`
- `audience_value`
- `audience_shape`
- `expiry`
- `service_identity`
- `issued_at`
- `token_lifetime`

These categories reveal only which validation class failed, never an assertion,
credential, header, claim value, upstream response, or exception message. The
receiver's signature, identity, destination, time and grant requirements are
unchanged. `jwks_unavailable` includes key retrieval/selection failures; it does
not establish whether the cause was a timeout, malformed key set, or absent key.
`expiry` includes expired/not-yet-valid or invalid required expiration claims.
An unknown exception becomes `assertion_shape`, not raw diagnostic text.

## OpenCode task in the Nomad repository

Update only the Number One bridge sender and its offline tests:

1. Keep the existing network activation gate, approved HTTPS destination,
   immutable-envelope rules, TLS verification, no redirects, timeouts, response
   limits, credential-file protections, and no-ACK-on-error behavior.
2. For a non-200 response, preserve its numeric status and extract only these
   optional diagnostic fields:
   - `content_type`: normalize to exactly `application/json`, `text/html`, or
     `other`; never print the raw header.
   - `ray_id`: accept only an ASCII full match
     `[0-9a-fA-F]{16,32}(?:-[A-Z]{3})?`, maximum 36 characters; otherwise omit.
   - `receiver_code`: only the exact string `INVENTORY_AUTH_REQUIRED`.
   - `auth_category`: only an exact member of the 12-category list above, and
     only when `receiver_code` matches.
3. Read an error body only for HTTP 401 with a single valid JSON content-type
   header and absent/identity content encoding. Apply the same existing 16 KiB
   streamed bound, header/length validation, and overall request timeout used
   for successful receipts. Parse an object with an object `error`; ignore all
   fields except the two allowlisted strings. Any malformed, oversized,
   compressed, duplicate-header, non-JSON, or unexpected response must still
   stop safely. It must never become an ACK or an instruction to retry.
4. Never emit or persist the raw body, arbitrary error message, URL/query,
   request/response headers, WWW-Authenticate, Cookie/Set-Cookie, credentials,
   JWTs, claim values, exception text, or tracebacks. Fixed enums are sufficient.
   Do not add verbose/debug mode or token decoding. Do not request another token.
5. Preserve `HTTP_401_STOP` as the primary error and the existing stop/retain
   action. Add a small optional `diagnostic` object to CLI JSON, containing only
   the fields above. Diagnostic parsing must not mutate the outbox or delivery
   table. For all non-200 statuses, retain existing STOP/RETRY_EXACT classification
   without actually retrying. If diagnostic parsing fails, omit the diagnostic
   rather than replacing the original HTTP status error.
6. Add offline tests covering each category, absent/unknown category, foreign
   error code, missing/invalid ray, HTML401, malformed JSON, oversized/chunked
   bodies, compressed responses, duplicate headers, unexpected nested fields,
   synthetic secrets in every ignored field, and exactly zero ACK/outbox mutation
   on errors. Check diagnostics stay below 512 serialized bytes and contain no
   synthetic secret canaries. Test the disabled sender still reads no credential
   and performs no network request.

Run the existing bridge suite and new tests. Commit the bounded change to the
existing review branch and report the exact commit and results. Do not submit an
envelope as part of this task. Once receiver diagnostics are separately deployed
and one exact retry is separately approved, its sanitized output can distinguish
an Access error page from a receiver rejection category.

## Exact-audience compatibility update

The receiver accepts the **same one configured audience identity** represented
as either an exact case-sensitive string or an exact one-element string array,
as permitted by [RFC 7519 section 4.1.3](https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.3).
JOSE still verifies that configured audience, RS256 signature and fixed issuer.
The additional check rejects multiple entries (even duplicate expected entries),
empty arrays, missing audiences, nonstrings and all different identities.

`audience_value` means a well-shaped single audience did not match.
`audience_shape` means missing/invalid/empty/multiple audience representation.
Neither returns audience values. The earlier `audience` diagnostic combined
these outcomes and cannot establish which caused a past live rejection. The
scalar compatibility defect is reproduced offline; it is not proof of the
actual live token's representation.

For a sender already implementing this document's previous revision, the only
new sender work is adding `audience_value` and `audience_shape` to its fixed
category allowlist and offline tests. It may retain legacy `audience` recognition
for older receivers. Do not relax parsing, reveal claims, reset the queue, or send
anything as part of this code update. Any retry remains separately approved and
must reuse the exact persisted envelope; no new scan is needed.
