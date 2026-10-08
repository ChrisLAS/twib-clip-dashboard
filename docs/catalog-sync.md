# Private catalog sync operations

## Deployment checklist

- Apply all D1 migrations before deploying a Worker that reads the new sync fields. Use the approved database only; migrations add metadata and do not remove reviews or clips.
- The deployed entry point must export both the authenticated `fetch` handler and the `scheduled` handler. A private static-asset wrapper must forward `scheduled(controller, env, ctx)` as well as `fetch`. Exporting only `fetch` silently omits automatic imports.
- Configure `*/5 * * * *` on the actual production Worker. Cron configuration in this sanitized source alone does not establish that a private deployment wrapper has that schedule. Cloudflare advises managing schedules through Wrangler when Wrangler owns the deployment configuration.
- Retain the approved origin, exact-owner Access checks, Google secrets, Sheet/range and episode/folder allowlists. This feature requires no new account grant, credential, public ingestion endpoint or browser Google access.
- Retain the existing configured CPU cap. Verify actual invocation CPU/runtime in production rather than assuming the platform maximum is the configured budget. A quota/CPU-killed invocation may not reach its error handler; the expiring lease and stale-success indicator are recovery evidence.
- Verify status under authenticated owner access, unchanged import replay, automatic scheduled success, and unchanged review/media behavior. Check denial for unauthenticated status requests too. Do not report cron as working based only on code export or trigger configuration.

## Work and cost bounds

The configured five-minute cadence schedules 288 checks per day (8,640 in a 30-day month), regardless of how many browser tabs are open. An unchanged catalog requires an OAuth refresh and a single bounded Sheet read; accepted manifest receipts bypass artifact re-verification and do not increment catalog revisions. Actual Google calls can be lower when an invocation is skipped while another holds the lease. New manifests perform additional database validation and Drive metadata checks; media bytes are not downloaded for importing. A response is capped at 2 MB and 100 rows. Each pass handles at most four previously unseen rows, 20 artifact checks and 800 work units; each unseen row is capped at 256,000 characters and 500 work units. Work units conservatively weight entity validation/write queries and include render-history references, transcript cues and QA checks. The 800-unit pass budget leaves headroom for row receipt lookups, lease checks and fixed database work. Budget-limited partial progress is retried from receipts on the next pass, with a visible status rather than a false success. Verify existing catalog rows fit these new limits before rollout.

The browser status endpoint reads D1 only. Its index includes at most 1,000 clips, and explicitly marks a truncated result incomplete so the UI does not invent exact counts. It exposes catalog revision metadata and sync health to the authenticated owner, not private Drive identifiers or Google credentials. Browser polling failures are separate from the last server sync result.

A D1 atomic lease serializes cron and manual import work. External work has a 120-second abort deadline, shorter than the 180-second lease. Each committing batch verifies lease ownership and expiry with the database clock; an expired or superseded invocation cannot commit catalog changes. Each manifest commits atomically. If a later Sheet row fails, earlier valid committed rows remain imported and visible; the successful-check timestamp does not advance. Retry can resume from durable receipts.

Cloudflare's documented platform limits distinguish active CPU time from time waiting for I/O. Paid scheduled jobs running more frequently than hourly have a 30-second platform CPU ceiling and a 15-minute wall-time ceiling; an explicitly configured lower CPU cap still needs to be respected. The current production budget must be validated independently. Do not change account plans, spending limits or CPU configuration to make the feature pass without authorization.

## Verification and recovery

1. Read `/api/catalog/status`: confirm configuration, catalog version, complete/incomplete index marker, last attempt/success, running state, and any error.
2. An unchanged accepted Sheet must preserve version and per-clip revisions and avoid Drive metadata calls. A new clip should become one new item; a new render for an existing clip should become an update, not another new clip.
3. An immutable-ID edit must yield a visible conflict, never silently overwrite a review or ignore changed producer metadata. Restore invalid unaccepted data or append correctly identified new work according to the producer contract.
4. Start a manual import while a scheduled import owns the lease: the second request must return `SYNC_IN_PROGRESS` without another Google import sequence. Abandoned work must become stale and recover after its lease expires.
5. Keep a video playing with a draft while a new catalog version appears. Only the notice/status should change. Apply from the slate; cancelled, superseded and stale requests must not change the current navigation or overwrite review state.
6. After deployment, allow Cloudflare's documented propagation window of up to 15 minutes for trigger changes. Observe a real scheduled success before calling automatic sync verified.

## Primary references

- [Cloudflare Cron Triggers and propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Worker CPU, wall-time and subrequest limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 batches and transactional execution](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Google Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits)
