# Implementation checkpoint

## Scope

Sanitized source is published in the public repository. All committed examples are fictional; real episode metadata, source imagery, media, Drive identifiers, review history, account details and secrets are excluded. The intended deployed app remains owner-only. No live deployment or new OAuth credentials/persistent grants have been configured.

## Implemented

- Owner-only Cloudflare Access JWT verification and same-origin/CSRF mutation guards
- Shared typed contracts and D1 immutable review events with revisions and idempotent retry reconciliation
- Exact-render feedback, separate production/editorial/visibility/airing state, Hide/Restore only
- Private Drive GET/HEAD streaming with metadata/hash checks and single byte ranges
- Allowlisted private-Sheet manifest pull, whole-manifest deduplication, render history advancement, producer-attempt ownership and stale-update logic
- React review interface with explicitly fictional demo mode and no real media
- Credential-free security/unit/SQLite integration tests and hosted browser regression workflow
- Offline transcript candidate matching, edition freshness checks and explicit source/render timing maps; no automatic airing confirmation or live feed adapter

## Validation

Local aggregate coverage includes frontend/backend/matcher lint and TypeScript, 101 deterministic tests, the frontend production build and Worker production dry-run. The immutable-manifest replay, full Worker-route SQLite tests and conservative transcript matcher are included. Run `npm run check` for the current revision.

Local D1 migrations succeeded. Local Worker/browser runtime restrictions were worked around only by running the normal test suite in an authorized hosted CI environment. Hosted Chrome on published commit `a1d49aea61025bda3063a31bd2c022cd171d641d` passed all 29 browser assertions, including actual synthetic H.264/AAC playback, seeking, mobile status visibility and media-error recovery. That run uses fictional intercepted API data and generated test media; it does not establish actual private Drive/Access integration. Every source push reruns the same workflow; see the repository's latest Actions result for its exact revision.

## Remaining gates

- Keep the exact published source commit and hosted CI checks verified
- Approve Cloudflare account, private hostname, costs, D1 and exact-owner Access setup
- Choose and approve a separate Google OAuth scope/grant and secure credential handoff
- Configure approved private Sheet/folders and test a real immutable manifest
- Prove actual private playback, seeks, hash-preserving download, expiry/revocation, all-origin access denial and phone/browser behavior

The offline matching package is not yet connected to live RSS, evidence persistence or the UI. Automated airing evidence ingestion, preference modeling, producer execution/resume and physical file deletion are not implemented. No “ready to air” claim is made.
