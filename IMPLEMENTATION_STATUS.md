# Implementation checkpoint

## Scope

Sanitized source is published in the public repository. All committed examples are fictional; real episode metadata, source imagery, media, Drive identifiers, review history, account details and secrets are excluded. The app remains owner-only. Private deployment configuration and integration credentials are maintained outside this public repository; this source alone does not establish their current live state.

## Implemented

- Owner-only Cloudflare Access JWT verification and same-origin/CSRF mutation guards
- Shared typed contracts and D1 immutable review events with revisions and idempotent retry reconciliation
- Exact-render feedback, separate production/editorial/visibility/airing state, Hide/Restore only
- Private Drive GET/HEAD streaming with metadata/hash checks and single byte ranges
- Allowlisted private-Sheet manifest pull, whole-manifest deduplication, render history advancement, producer-attempt ownership and stale-update logic
- Five-minute server-side catalog sync with a durable manual/cron lease, deadline and atomic commit fencing; persisted sync health and no-op fingerprints
- Visible-tab catalog notices with truthful new/changed counts, explicit slate-only apply, request cancellation, and review/player/draft preservation
- Episode workspace picker with empty active drafts, published history and navigation/request guards
- Manual source-link intake with separate pending state, provenance, duplicate checks, safe URL validation, revisions, recoverable cancellation and idempotent receipt reconciliation
- Private configured Drive-folder link-out for owner uploads; no dashboard upload grant or downstream media processing
- React review interface with explicitly fictional demo mode and no real media
- Credential-free security/unit/SQLite integration tests and hosted browser regression workflow
- Bounded RSS/SRT/chapter ingestion with independent offset-hourly invocation, durable retry/backoff and edition history; private feed/host configuration and actual scheduled success remain rollout gates
- Offline transcript candidate production, persisted owner-scoped evidence and explicit full/partial/unknown verification with atomic source/episode freshness checks, immutable correction history and uncertain-save reconciliation
- Versioned owner-editable editorial profile, scoped feedback/proposals, cross-episode exact-render review examples and honest context-use receipts; read-only authorized connector consumption contract
- Portable local media producer with durable hash-verified checkpoints, real process-interruption recovery, safe bounded media processing and a manifest bridge; no connected producer host, credentials, upload or runtime

## Validation

Local aggregate coverage includes frontend/backend/matcher lint and TypeScript, deterministic catalog-sync/security/SQLite/reconciliation tests, the frontend production build and Worker production dry-run. The episode/intake implementation currently passes 315 deterministic tests locally, including unsafe URLs, source ranges, duplicate and revision races, immutable provenance, owner scoping, catalog fences and uncertain client saves. The browser harness preserves 68 existing assertions and adds 43 episode/intake assertions, for 111 expected assertions including interrupted saves, duplicate resolution and cross-episode history. These new assertions are not yet executed locally. Local Chromium cannot launch in this environment, so the new browser assertions require hosted execution on the exact published revision. Run `npm run check` for the current revision; use the documented writable Wrangler log/config locations when the home directory is unavailable.

Local D1 migrations succeeded. Local Worker/browser runtime restrictions were worked around only by running the normal test suite in an authorized hosted CI environment. Hosted Chrome on published commit `a1d49aea61025bda3063a31bd2c022cd171d641d` passed all 29 browser assertions, including actual synthetic H.264/AAC playback, seeking, mobile status visibility and media-error recovery. That run uses fictional intercepted API data and generated test media; it does not establish actual private Drive/Access integration. Every source push reruns the same workflow; see the repository's latest Actions result for its exact revision.

## Remaining gates

- Keep the exact published source commit and hosted CI checks verified; local browser launch is restricted in this execution environment
- Apply the additive episode-workspace/intake migration before deploying code that reads its new tables; privately bootstrap workspace/folder metadata and read it back without editing imported episodes or reviews
- Forward the scheduled handler through any private deployment wrapper and configure the production five-minute trigger
- Check existing private rows against the bounded import budget; measure warm and changed-row invocation CPU against the unchanged configured cap
- Observe an actual scheduled success, unchanged catalog version on replay, and preserved live review/playback behavior before reporting rollout complete
- Retain exact-owner Access, private origin restrictions, approved Google credentials and Sheet/folder/episode allowlists

See [manual intake rollout](docs/manual-intake.md) and [catalog sync operations](docs/catalog-sync.md) for bounds, recovery and verification. Credential-free tests and synthetic hosted browser coverage do not establish real private Drive/Access integration on their own.

## Publication, editorial and portable-producer release

The current source adds additive migrations 0005–0007, a separate `2 * * * *` publication trigger while retaining the five-minute catalog trigger, owner-only workflow panels and canonical read-only editorial context. Apply migrations before deploying routes; register the exact production triggers and privately configure the trusted feed/asset hosts. The public source includes no real private profile, reviews, transcripts or manifest data.

A real public-input smoke benchmark in local workerd parsed the 749,336-byte RSS and 87,507-byte SRT with original/normalized hashing; host-observed timings are recorded in docs/publication.md. These wall-time measurements exclude D1/network and are not billed CPU or proof of production headroom. The 50ms configured CPU ceiling remains unchanged. Verify actual scheduled success and production CPU separately.

Automatic candidate generation is not connected to an edge or durable producer runtime. The offline matching CLI can create candidate JSON from authorized owner exports; text alone never confirms airing. The local media producer is recoverable and tested with real ffmpeg interruption, but requires separately authorized hosting, transcription and output-write integration for unattended work. No machine credentials, account plan changes or new services were created. No automatic model training or inferred permanent tastes are claimed.

See docs/publication.md, docs/editorial-context.md, docs/airing-evidence.md and packages/producer/README.md for exact contracts and limits. Current aggregate results and exact-revision hosted browser coverage must be verified before deployment; this source checkpoint alone does not establish live owner access, feed execution or connected processing.

The follow-on exact-render transcript adapter adds migrations0008–0009. Machine ASR assets are immutable, hash-bound and explicitly text-unverified/source-mapping-unknown; they permit candidate discovery without changing historical render mapping flags. A corrected latest transcript makes earlier evidence stale. The private starter-profile helper uses an explicit assistant_bootstrap event actor and a fresh-profile/reviewer-principal guard. Current clean-room validation: npm ci succeeded, then all415 tests plus lint, typechecks, frontend build and Worker dry-run passed; local D1 migrations through0009 applied successfully. Hosted browser/production verification remains a separate gate.

The opt-in lifecycle extension adds migration0010 and leaves PUBLICATION_AUTO_ROLLOVER off by default. Fresh, uniquely identified publication of the active draft can atomically publish it and activate the next draft while preserving existing content. Immutable receipts, raw identity guards and workspace/catalog revision fences prevent replay, ambiguity or intervening host choice from moving focus. New drafts have no configured upload folder. Independent review reproduced and verified fixes for hidden imported-number and cross-workspace GUID conflicts. Runtime activation and observed production success still require the deployment gate.
