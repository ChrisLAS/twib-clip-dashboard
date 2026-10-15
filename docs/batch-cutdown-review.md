# Long-clip batch cutdown requests

This slice builds on draft PR 6, exact base `5f1ac28`. It is not deployed or activated.

- The inventory API accepts `duration=over_300` (strictly greater than 300 seconds) and `sort=duration`. Filtering and numeric sorting happen before pagination; unknown durations sort last and do not match the long-clip filter. Cursor scope includes the duration filter.
- The owner can select up to 20 eligible long clips across pages. Ambiguous identities, truncated/conflicting observations and unsaved row reviews are excluded. Each source/review version is captured explicitly.
- Batch guidance, clip-specific guidance and timecodes are optional. Empty guidance creates a `first_pass` request; start-only is a hint. A complete positive range of at most 180 seconds uses the existing range contract. Exact ranges take precedence over prose, with an explicit UI notice.
- Submission is bounded and sequential. Each item retains its own operation UUID, payload and result. Unconfirmed requests retry the same payload and UUID; saved items are skipped. Definite validation/conflict failures allow clearing/reselection. The server remains authoritative for stale-source and review-revision checks.
- Original notes are preserved. Nothing in the batch UI overwrites media, marks a derivative approved, or changes production ordering. Existing per-request provenance and derivative references remain in row review history.
- Before the first POST, all immutable operation payloads/UUIDs are durably written and read back in an authenticated owner/source/episode-scoped browser outbox. Only schema, scope, request payloads and minimal outcome receipts are stored; no CSRF token or full inventory record is stored.
- Reload restores pending, confirmed and unsent items. Reconciliation replays the same operation UUID/payload through the existing server idempotency receipt mechanism; confirmed items are skipped. An unresolved batch blocks creating another. Corrupt, unavailable or mismatched storage fails closed; Web Locks prevent cooperating tabs from racing submissions.
- Unsaved row-draft protection uses the complete source/episode draft registry, not the visible page. Account changes remount the inventory workspace and do not restore another owner's outbox.

## Verification

`npm run check` passes with the installed NixOS glibc loader wrapper supplied through `MINIFLARE_WORKERD_PATH` for workerd. No service/security changes or downloads are required by that test-only wrapper. The initial unwrapped run failed three runtime tests because NixOS cannot execute their generic Linux binary directly.

`CHROMIUM_PATH=<installed Nix Chrome> node security-review/inventory-batch-regression.mjs` covers desktop and narrow mobile: selection across pages, no required guidance, partial failures, exact UUID replay, skipping successful saves, stale source rejection and recovery from a definite 409 rejection. All APIs/media are synthetic. Screenshots are generated in ignored `test-results/` and are not production evidence.

The existing `npm ci` lockfile reports six dependency advisories (one moderate, three high, two critical). No dependency changes are included in this slice. Assess separately before rollout rather than applying an unreviewed broad dependency update.

`CHROMIUM_PATH=<installed Nix Chrome> node security-review/inventory-batch-durability.mjs` additionally verifies lost acknowledgements after server commit, reload during a batch, exact operation replay without duplicate effects, unsent retention, saved skipping, storage quota/denial/corruption/owner mismatch and account isolation on desktop/mobile.
