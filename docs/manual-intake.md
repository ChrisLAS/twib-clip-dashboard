# Episode workspaces and manual intake

## Scope and boundaries

The episode picker selects a review workspace. Workspace metadata is separate from immutable producer episode manifests, so an empty draft can exist before its first imported clip. A published episode remains available with its original clips, renders and saved reviews. Production workspace IDs, titles and private folder URLs are configured outside this sanitized repository.

Manual intake records a source the owner found. It does **not** create a render, start a media job, download a submitted URL, grant Google write access, or declare a clip ready. A successfully committed submission is shown as **Added by you — Saved, awaiting processing**. No durable processor is connected by this feature. Pending intake and reviewable clips retain distinct counts and records.

A submission includes a source URL or private Drive file link, an optional episode (otherwise Unassigned), already-cut/full-source classification, optional source-time range, and an optional explanation of why it matters. Original submitted links are retained as provenance; recognized providers can also receive a stable canonical identity for duplicate detection. Arbitrary website query strings are not stripped or reinterpreted.

For a local file, the dashboard opens the configured private episode folder in Drive. The owner uploads using Drive's own interface, then pastes the resulting file link. This is a link-out workflow, not a dashboard upload capability. Missing folder configuration must remain visible as unavailable rather than be replaced with a guessed URL.

## Safety and consistency

- Shared frontend/backend validation rejects unsafe URL schemes, credentials and internal hosts. Submitted URLs are stored as untrusted data and never fetched by this intake API.
- Duplicate source/range matches point to existing work; a different cut is a deliberate action, never a silent overwrite or a new copy of an existing render.
- Idempotency keys and committed operation receipts distinguish a confirmed save from an uncertain network response. Reuse an identical request/key when reconciling; changed content requires a new key after the prior outcome is resolved.
- Revisions guard pending-note/range corrections and recoverable cancellation. A stale revision must refresh and be reviewed before another deliberate save. No clip or Drive file is moved or deleted.
- Intake mutations do not write producer events, manifest receipts, render QA or editorial decisions. Saved explanations are evidence attached to that submission, not a learned permanent preference.
- Switching episodes and explicit refresh/apply invalidate older loads. A late response for a previous episode must not replace the active workspace or current render. Review drafts remain keyed to the exact render, and an open player is not replaced by polling.
- Catalog checks expose intake changes separately from imported catalog changes. An intake update never increments a ready-clip count or supplies an invented playback target.

## Rollout and verification

Apply the additive workspace/intake migration before serving the new endpoints. Configure private workspace metadata through the approved deployment process, preserving existing imported records and reviews. Keep existing exact-owner Access, CSRF/origin guards, Google credentials, allowlists, scheduled catalog sync and CPU cap unchanged. The upload folder must be an owner-verified private Drive folder; exposing its link to the authenticated owner does not authorize any sharing change.

Verify an empty active draft and a populated published episode; switching away/back and refreshing; immediate pending intake visibility; duplicate and invalid-time handling; uncertain-save reconciliation with the same key; old-response suppression; review draft preservation; pending/ready count separation; and the safe external Drive folder link. Synthetic tests do not establish production folder ownership, live Access, or downstream media processing.

Durable processing, producer linkage to intake, feedback/profile learning, automatic RSS-created drafts and automatic episode rollover are separate future phases. There is no claim that this phase completes those workflows.

### Private workspace bootstrap

Migration `0004_episode_workspaces_intake.sql` creates the tables without real episode or folder values. Its guard trigger uses `SELECT RAISE ... WHERE` and `iif()` rather than nested `CASE ... END`, preserving SQLite guard behavior while remaining compatible with D1 REST statement splitting. A local SQLite migration pass alone does not establish D1 REST parser compatibility. `episode_workspaces` takes `id`, JSON `data` (`id`, `number`, `title`, `subtitle`, `publishedGuid`), `status` (`draft`, `published`, `archived`), `is_active` (0/1), `revision` (default 1), and nullable `upload_folder_url`. The row ID must match the JSON ID. A unique index permits one active workspace, which must be a draft. Use bound parameters in the approved private deployment process, verify preexisting rows first, and read back after commit before retrying an uncertain result.

The workspace overlay supplies planning/display metadata while imported episode data remains unchanged. An imported non-null published GUID remains authoritative; otherwise the workspace may supply it. Workspace changes advance a separate workspace version. Intake events advance a separate intake version and retain immutable provenance, event history and operation receipts. They do not advance the producer catalog version.

An episode workspace does not grant the producer permission to import into it. Approved episode and immediate Drive parent-folder allowlists remain independent deployment controls, and any required update must be applied deliberately through the existing authorized process. No new grant or credential is required to open a Drive folder link.
