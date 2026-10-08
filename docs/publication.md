# Public publication ingestion

## Configuration and rollout

Apply migration `0005_publication.sql` after migrations 0001–0004. Configure `PUBLICATION_FEED_URL` privately (Worker secret/environment configuration); never put the real feed URL, source content, or account identifiers in this repository. Set `PUBLICATION_ALLOWED_HOSTS` to comma-separated **exact trusted public hostnames** for the RSS feed and advertised SRT/chapter files, including any intended redirect destinations. The feed cannot expand this list. Hostname trust is an operator responsibility: do not allow arbitrary user-controlled or private-DNS hosts.

`PUBLICATION_AUTO_ROLLOVER=true` optionally creates an empty **inactive** next-number draft after a unique workspace-number match. Default is off. This intentionally does not automatically advance the host's active workspace, replace any title, mark its draft published, import media, or move clips/intake. Existing next-number drafts are preserved. Confirm the current host workspace through the existing owner workflow.

Call `syncPublication(env)` only from the offset hourly `2 * * * *` scheduled event. Dispatch by the event cron string so the existing `*/5 * * * *` catalog sync remains separate and unchanged. A durable D1 lease and hourly due gate prevent overlapping or excess feed polling. The next due timestamp aligns to the next :02 UTC boundary, so delivery jitter cannot accidentally skip the next hourly invocation. A check records the next hourly attempt before external I/O, so failures/crashes cannot create a retry storm. Owner-authenticated, CSRF-protected manual refresh may call `syncPublication(env,{force:true})`; force does not bypass an active lease. Local demo performs no real fetches. The catalog cron and production `cpu_ms = 50` are unchanged; publication uses the same Worker with its separate offset-hourly event, no new service.

## Scope and state

Each check processes the latest RSS episode only; previous observed episode editions and asset versions remain stored. This is **not full historical backfill**. RSS supports GUID, title, `itunes:episode`, publication date, enclosure metadata, `podcast:transcript` with SRT MIME type, and `podcast:chapters` with `application/json+chapters`. Episode numbers must be explicit positive numeric values; no guess is made from a title. A unique existing episode/workspace number maps an episode. Ambiguity leaves it unmapped, and no unrelated archive workspace is created.

RSS, transcript, and chapter assets have separate state, checked/fetched timestamps, original SHA-256, ETag, Last-Modified, and cached content. A 304 feed still causes independent advertised-asset checks. A changed URL discards its old conditional validators. Blocked/malformed/unavailable transcripts do not prevent chapters from succeeding. A 401 or 403 is displayed as blocked; no credentials, alternate authenticated route, or access bypass is attempted. Hourly checks retry when each asset is due. Durable per-asset next-retry timestamps and failure counts honor `Retry-After` (seconds or HTTP date), including during manual refresh. Transient failures back off exponentially from one hour to at most 24 hours; a longer server-requested delay takes precedence. Successful fetches reset backoff. Cached RSS permits independently due asset checks even while RSS itself is backed off; RSS remains visibly errored and verification is unavailable until it recovers. Errors are generic and do not disclose fetch URLs or external response bodies. Last successful content stays cached after same-URL errors, visibly marked blocked/error, rather than silently pretending it was refreshed.

The status API contains only status and edition metadata, not configured feed or asset URLs, transcript bodies, validators, or raw errors. `getPublishedTranscript(db,episodeId)` is an owner-only export input for offline evidence generation, not a public endpoint.

## Integrity and evidence

The source-original SRT SHA-256 is computed from fetched bytes **before decoding or normalization**. UTF-8 is required, decoding is fatal on invalid bytes, and BOM/CRLF are retained in cached original text. Parsing permits the known exporter timestamp `,1000` by carrying one second arithmetically, including minute/hour rollover. The normalized cue serialization gets a separate SHA-256. These hashes are not interchangeable. Every unique source hash retains its original text and normalized parsed representation in `publication_asset_versions`.

An edition fingerprint hashes a versioned representation of feed identity, exact episode metadata (including advertised asset URLs), and original transcript/chapter hashes. It changes for changed bytes or changed source identity. Immutable edition observations are retained. This is an **edition observation fingerprint**, not proof of exact episode audio bytes: `mediaFingerprint` is always null. RSS enclosure URL, length and MIME type cannot establish a media hash or render identity. Offline evidence must establish actual media fingerprints separately; no text match automatically confirms airing.

`getPublishedEdition` requires one unambiguous episode mapping, current transcript state ready, a transcript hash matching the episode projection, and RSS state ready. Failed cached assets cannot justify fresh confirmation. Any confirmation mutation must repeat equivalent checks and compare the edition fingerprint inside its atomic D1 transaction. The join key is `publication_episodes.transcript_asset_key`. A newer RSS episode does not invalidate an older episode solely because it is no longer latest.

## Bounds and security

- HTTPS only, no credentials, nonstandard ports, IP literals, localhost/private suffixes, or unlisted hosts
- Every redirect is revalidated; at most three redirects, no automatic follow
- 12 seconds per whole fetch/redirect/body read, 45-second invocation network deadline, 90-second fenced lease
- Streaming byte caps: RSS 1 MiB (the observed baseline feed is about 750 KB), SRT 512 KiB, chapters 128 KiB
- RSS maximum 500 items, 50,000 tokens, depth 24; DTD/entity declarations rejected
- SRT maximum 6,000 cues; ordered finite ranges and a seven-day coordinate ceiling
- Chapters maximum 1,000 entries; ordered finite nonnegative timestamps
- No downloaded episode audio; no external AI call, new infrastructure, or new runtime dependency

## Verification

Run `npx vitest run apps/worker/test/publication.test.ts`, typecheck and lint. Tests use exclusively fictional content and cover parsing, carry normalization, source hashes, URL validation, redirect rejection, bounded streaming, blocked-source retries, independent assets, conditional caching, hourly gating, ambiguous mapping, workspace preservation, idempotent opt-in rollover, edition changes/history, Retry-After/backoff, active-lease exclusion, expired-owner fencing, and a 750 KB feed.

Run `node security-review/publication-benchmark.mjs` for a local **workerd** parser/hash smoke benchmark through Miniflare. A recorded run used a 338,392-byte fictional SRT (3,500 cues), one RSS item and 80 chapters, with 25 measured requests after warm-up: p50 8.55 ms, p95 12.59 ms, max 14.54 ms. These are host-observed **wall times including local IPC**, not Cloudflare billed CPU, and exclude external network/D1. They do not prove production stays below 50 ms for every input or concurrent scheduled catalog work. Production CPU profiling remains necessary; the ceiling was not raised and no production fetch/deployment was performed by this implementation task.

A second local-workerd benchmark read the existing 749,336-byte public feed directly from its local input file (128 items), without copying source content into the repository, alongside the same 338,392-byte fictional SRT/80 chapters. Across 25 measured requests: p50 wall 21.48 ms, p95 28.10 ms, max 32.57 ms. To benchmark an existing local feed, pass its path as the script's first argument; an optional second argument supplies an existing SRT without copying it into the repository. This still excludes database/network work and deployment-specific overhead. It is a smoke measurement, not permission to raise limits or a production CPU guarantee.

`lastScheduledSuccessAt` records an observed successful scheduled/default invocation only; owner manual refresh does not advance it. Configuration presence, a cron string in source, and `lastSuccessAt` alone do not prove the production scheduler has run.

A final actual-input smoke run included SHA-256 of original and parsed RSS, SRT and chapters: existing 749,336-byte RSS plus existing 87,507-byte SRT (914 cues), with 80 fictional chapters, 25 measured local workerd requests. Observed p50 wall 19.98 ms, p95 37.69 ms, max 48.23 ms. Host load/IPC affects these wall measurements; this is not billed CPU and does not prove headroom under 50 ms. Production profiling remains a rollout check. No real input content was copied into committed fixtures.
