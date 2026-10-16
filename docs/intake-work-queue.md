# Manual-intake work queue

This is a build-only integration. It does not deploy, enable flags, grant access, run a Nomad worker or establish that a source was downloaded or reviewed.

## Owner workflow

1. Save the intake with an episode assignment. Work requires a current, active draft episode; unassigned or cancelled intake is ineligible.
2. Resolve local draft edits, choose normal or urgent priority and explicitly select **Save work request**. Guidance is optional; no mandatory note is generated.
3. Use **Refresh work status** for current processing status. Saving an intake alone never submits work; editing never automatically resubmits it.
4. Review the original and final cut separately through the existing review workflow.

A request captures an immutable intake revision, episode ID/number and workspace revision. Source, range and optional guidance belong to that snapshot. Later edits, cancellation or episode changes can supersede its processing authority. Old work remains visibly bound to its original revision.

The server derives a stable job ID and enforces one request per owner/intake/revision. Replaying the same priority is safe; changing priority for that revision conflicts.

## Saved versus dispatched

`INTAKE_WORK_REQUESTS_ENABLED` defaults off: only literal `true` enables requests. No tracked activation configuration is added.

Request acceptance and dispatch are separate. A saved request with processing disabled is durable intent, not a successful download. The capture dispatch summary also requires `CAPTURE_JOBS_ENABLED`, a capture-kind grant and a valid episode grant; individual jobs remain subject to exact grant, episode and current-intent checks. Planning, range execution and automatic first-pass gates remain separate. Do not infer that they are enabled from the capture summary.

Stages include saved, queued, downloading, awaiting inventory, planning, cutting, needs direction, ready for review, blocked and error. Transcription is not reported as a distinct active stage until a worker provides that evidence. Stale or superseded work is not proof of current progress. **Ready for review means an unreviewed derivative exists; it does not mean Chad or another human reviewed it.** Processing intent grants no human review credit, editorial approval or final-cut approval. Original media and its review records remain separate and preserved.

## API and recovery

- `GET /api/intake/work`: owner-scoped `enabled`, `dispatchEnabled` and job views.
- `POST /api/intake/:id/work`: `expectedRevision` and `priority`.
- `POST /api/intake/:id/work/:jobId/retry`: `expectedAttempt` and `expectedTargetId`.

The root job ID identifies the work request. A retry target may identify its downstream plan or cut. The browser retains that exact target and attempt; it must never redirect an uncertain capture retry to a later cut. Legacy calls without a target refer to the root only. Retry controls appear only when the server explicitly reports `retryable: true`.

The owner-scoped browser outbox uses a versioned localStorage envelope with scope, owner and exact request. It stores no CSRF token. Writes are read back before POST. Owner-scoped exclusive Web Locks protect reservation and exact-envelope removal across tabs; unavailable locking fails closed, and a stale tab cannot remove or overwrite a newer pending request. Account changes remount the panel; malformed, wrong-owner, legacy unscoped or unavailable storage blocks submissions. Reload and tab closure preserve uncertain requests. Refresh reconciles a matching target after its attempt advances, or when the same attempt is queued/running. Mounting, editing or refreshing never automatically submits work.

## Migration and disabled pilot checklist

Migration `0018_intake_work_requests.sql` adds immutable request records, unique owner/intake/revision identity, immutable downstream linking and a processing-authorization view. That view is not an editorial review. Apply and verify the migration only under an explicitly approved deployment plan; do not enable request handling before the schema exists.

Before any pilot, obtain separate approval for the target environment, episode, bounded source work and one-shot Nomad capture/plan/cut execution. Verify:

- Deployment and migration approval, with request and worker flags initially off.
- Authenticated owner, active draft episode and unchanged intake/workspace revision.
- Narrow source/show/episode, operation and time-bounded worker grants; no unrelated credential or scope expansion.
- Capture, planning and cut gates independently; saved work stays honestly saved when its next stage is disabled.
- Inventory receipt/provenance, transcript and native-parent requirements before downstream work. Capture proof must match the current positive job attempt basename and a worker-supported media extension, then independently match latest native inventory hash/size/duration.
- Separate original and derivative review, with no automatic human-review credit.

**Current limitation:** inventory ingestion authentication remains pinned to episode 127 (`apps/worker/src/inventory/auth.ts`). This slice is not general multi-episode ingestion. A non-127 pilot requires a separately reviewed ingestion-scope change; creating an episode-bound request does not remove that blocker.

## Verification

`npx vitest run apps/web/src/intake-work-panel.test.ts apps/web/src/intake-state.test.ts` covers recovery identity and existing intake guards.

`node security-review/intake-work-browser-regression.mjs` uses a local synthetic fixture and mocked APIs. It covers explicit saves with dispatch off, immutable revisions, no automatic submission, exact replay, backend-gated retries, stale status, draft protection, owner changes, tab closure and invalid/unavailable storage. Set `CHROME_BIN` to an installed Chrome executable and optionally `SCREENSHOT_DIR` to retain screenshots. Screenshots are synthetic UI evidence, not production or editorial-review evidence.

Run frontend lint, typecheck and build plus backend/full repository checks before rollout. Passing local tests does not activate the pilot.

Inventory-triggered recovery advances at most 20 current, unlinked requests per event, least recently checked first. Completed links are excluded so old work cannot starve new work. This is a bounded single-link pilot; no autonomous background sweep or unattended multi-kind schedule is installed.
