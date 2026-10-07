# Independent security and consistency review

Scope: local implementation and isolated fixtures only. No deployment, new credentials, Google consent, public sharing, or live Access/Drive integration was performed.

## Executed coverage

Run: `npx vitest run security-review`

Latest result: **51 tests passed across 4 files**.

- Access uses real RSA signatures and `jose.jwtVerify`; tests replace remote JWKS transport with ephemeral local keys. Valid owner succeeds; tampered signature, wrong issuer/audience/account, expired token fail.
- Unauthenticated UI, assets, API, and media requests fail before binding access. Missing configuration, alternate origins, and production request-driven demo attempts fail closed.
- Mutations require matching origin and CSRF token. Media routing rejects URL-shaped and unregistered IDs.
- Mock Drive transport covers single/suffix/open-ended ranges, 206, 416 size headers, metadata-only HEAD, HTML rejection, no token exposure, missing OAuth.
- Consistency tests cover exact idempotency fingerprints after a zero-row race, stale attempts, no refresh heartbeat, replay receipts, schema keys/references/attempt ownership, and readiness evidence.
- Client tests cover lost-response reconciliation and authorization rejection.

## Findings repaired during review

1. Final idempotency reconciliation omitted fingerprint comparison after racing zero-row inserts.
2. Clip metadata immutability initially prevented advancing to a new render; revised pointer/history validation permits it.
3. Importer duplicate keys, cross-clip attempt IDs, and unresolved render references needed rejection.
4. Replaying historical manifests after advancing a render could halt subsequent imports; atomic manifest receipts now skip accepted rows.
5. Frontend always requested optional proxy even for original-only media; fallback now uses original.
6. Transcript cue seeking mixed source and render coordinates; render-relative seeking now matches schema.
7. Draft state was lost on navigation or could carry to a replacement render; drafts are now keyed by exact render ID, and writes use that ID.
8. UI mutations now use a synchronous lock, preserving server acknowledgement before saved state.

## Final rechecks

- Null artifact/QA hashes no longer satisfy readiness: regression passed.
- HTTP 5xx uncertain saves now reconcile by operation ID: regression passed.
- Undo now checks exact render ID and committed revision before writing: statically verified; browser execution blocked.

## Browser and live-integration limitations

A GitHub Actions browser job is prepared to run this harness in a standard hosted runner, using only fabricated fixtures and no credentials. Hosted execution has not yet been verified; do not treat prepared CI as a passing browser test.

`browser-regression.mjs` is a prepared Playwright interaction harness using intercepted API/media fixtures. It was not executed past browser launch: Chromium failed with `socket() Operation not permitted` in process singleton initialization. The separate visual test attempt hit the same runtime restriction, including approved escalation. Cloud-browser localhost access was rejected. No bypass was attempted.

Consequently real browser navigation, focus/keyboard, duplicate clicks, draft retention, real video decoding/seek, download checksum, mobile behavior, and owner-login/private-Drive behavior are not claimed as passed. Static review and unit fixtures are not a substitute for the release integration gate.

For a permitted browser environment: start the frontend dev server on 127.0.0.1:5173, provide an installed Playwright module (`PLAYWRIGHT_MODULE` can specify its package path), and run `node security-review/browser-regression.mjs`. The default is Playwright-managed Chromium; `CHROMIUM_PATH` optionally selects a permitted system executable. The harness uses fabricated metadata and intercepts all API/media traffic; it does not access private videos.
