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

**Inventory grant requirement:** inventory ingestion requires an explicit single `INVENTORY_GRANT_EPISODE_NUMBER` (1–999999), with no default or active-workspace inference. Missing or malformed configuration fails closed, including for the historic episode-127 pilot. This is not general multi-episode ingestion: each pilot still requires a separately approved exact episode and time-bounded private grant. Creating an episode-bound request does not activate inventory ingestion. See [the pilot contract](number-one-pilot.md).

## Verification

`npx vitest run apps/web/src/intake-work-panel.test.ts apps/web/src/intake-state.test.ts` covers recovery identity and existing intake guards.

`node security-review/intake-work-browser-regression.mjs` uses a local synthetic fixture and mocked APIs. It covers explicit saves with dispatch off, immutable revisions, no automatic submission, exact replay, backend-gated retries, stale status, draft protection, owner changes, tab closure and invalid/unavailable storage. Set `CHROME_BIN` to an installed Chrome executable and optionally `SCREENSHOT_DIR` to retain screenshots. Screenshots are synthetic UI evidence, not production or editorial-review evidence.

Run frontend lint, typecheck and build plus backend/full repository checks before rollout. Passing local tests does not activate the pilot.

Inventory-triggered recovery advances at most 20 current, unlinked requests per event, least recently checked first. Completed links are excluded so old work cannot starve new work. This is a bounded single-link pilot; no autonomous background sweep or unattended multi-kind schedule is installed.

## Human-selected range after full-source capture

A full-source intake can pause after capture and native inventory with planning
and model providers disabled. Its immutable first-pass cut remains `needs_review`.
After listening or reviewing a local transcript, an authenticated owner can choose
one exact range without changing the intake revision or capturing again:

1. Read `GET /api/intake/work`. Retain the original work's `rangeSelection` object.
2. Submit `POST /api/intake/:intakeId/work/:jobId/range` with exact same-origin
   owner session and CSRF protection. The JSON body contains every field from
   `rangeSelection` plus `range: {kind: "range", startSeconds, endSeconds}`.
3. The range must use millisecond precision, start at or after zero, end within the
   verified original duration, and last at most 180 seconds. The source, native
   identities, hash, path and inventory proof are derived on the server.
4. The response is `{requestId, sourcePlanRequestId, selectionOrigin: "owner_range"}`.
   Work-list readback follows this linked child through queueing, cutting and
   unreviewed derivative receipt. The original intake notes, work spec and
   first-pass request remain unchanged. No model proposal or human approval is
   invented, and no source capture is queued again.

Only an unplanned first-pass request with no execution job/proposal/derivative is
eligible. Current owner/intake/workspace/episode/parent-version bindings, native
capture evidence and duplicate-parent checks are mandatory. New selection also
requires enabled intake/capture/cut gates, exact source/show/episode/action and
cut-operation grants, and a current configured grant interval of at most seven days for capture/cut-only operations. Any grant including planning
retains the 24-hour ceiling.
The pilot may configure a shorter window (for example two hours); selection never
extends it. Planning and automatic-first-pass gates are irrelevant to this owner
choice. Already-started planning must be reconciled separately.

The child identity is deterministic per original request. Same-choice replay
acknowledges the same committed child even after grant expiry, without extending
or requeueing it; owner/current-intent/parent checks still apply. Changed choices
conflict. Atomic guards and the existing unique child link prevent competing
choices or a delayed original-plan enqueue from creating two work paths. Do not
edit database rows or replace original cut JSON to change direction.

This endpoint does not generalize the separate inventory review UI: its numeric
inventory selector and ordinary review POST still retain the historic episode-127
scope. Episode-128 manual range selection uses the exact intake-bound endpoint
above. Broadening ordinary inventory review needs its own workspace-bound change.

## Prospective machine claims

The authenticated job grant start is also an issuance cutoff. New claims and
claim replays require the immutable owner work request to have been created at
or after that start. A downstream cut uses its intake root's creation time, not
the later queue time. Direct owner capture requests use their original job
creation time; direct cut/plan requests use their original cut request (or
first-pass parent) creation time. Missing or malformed roots fail closed.

Retries within the same grant retain eligibility. Moving the grant start forward
intentionally excludes earlier requests and their retries, even when their
downstream jobs were created later. This does not change result reconciliation:
existing lease/attempt and authentication checks still govern receipts. The
cutoff is checked in the atomic claim selection, not only a queue preflight.
