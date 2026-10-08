# Editorial workbench frontend

React + TypeScript + Vite. The charcoal/copper interface includes a responsive episode slate, focused review desk, optional keyboard actions, source context and separate editorial, production, QA, visibility and airing states.

## Local run

From the repository root, install with `npm ci` and start `npm run dev`. The Vite server binds to loopback at `http://127.0.0.1:5173` and proxies `/api` and `/media` to the local Worker at port 8787.

- `/` uses the real API contract, including session CSRF tokens and server-confirmed mutations.
- `/?demo=1` is available only on `localhost` or `127.0.0.1`. It uses fictional metadata and locally generated waveform SVGs. It never loads private media. Demo decisions stay in memory and reset on page reload.
- Unsaved note drafts are keyed to an exact render in tab-scoped `sessionStorage`, with an in-memory fallback if storage is unavailable. Drafts are cleared from storage after saving. Do not use a shared browser tab for confidential review.

## Automatic catalog updates

In a configured production workspace, the Worker checks its approved catalog on its server schedule. The browser never triggers an import on open, refresh, polling, or tab visibility changes, and never receives Google credentials or catalog file IDs.

The frontend reads `/api/catalog/status` every 30 seconds while visible, with one request at a time. Hiding or leaving the page cancels the current status request; returning to the tab checks again. The UI shows the last successful sync, stale or failed imports, and failures to check status. A failed poll keeps the last known status visible.

Opening the workspace loads the latest stored slate. Later catalog updates produce a polite new/changed-clip notice without replacing an active player, review, note, or filter. Counts compare complete per-clip catalog revisions against the applied episode snapshot. Incomplete or older-format snapshots get an uncounted notice rather than guessed counts. Review and visibility saves do not create producer-change notices.

Use **Apply updates** on the slate to load imported changes. A review offers **Return to slate** first. Apply/Refresh is single-flight and disabled during a save. **Cancel refresh**, clip navigation, browser Back/Forward, or a new local save invalidates a pending slate response, even if the request finishes after cancellation. A stale read cannot overwrite a newer saved review/visibility revision. Drafts remain keyed to their exact render; a new render does not inherit an old decision or note.

Manual **Import approved clips** is available only inside the collapsed **Troubleshooting** details. It remains a deliberate CSRF-protected server operation and does not automatically refresh or interrupt reviews.

## Episode workspaces and manual intake

The Episode picker includes empty drafts and published workspaces. First visits prefer the configured active draft; an explicit `?episode=ID` selection survives reload. Switching episodes cancels the previous slate request and invalidates its results. Back/Forward review entries retain episode, clip and exact render identity. If that version is no longer current, the app returns to the slate rather than replacing it silently. Episode switching is unavailable during a save or an open review; return to the slate first. Render-specific note drafts are preserved.

**Add clip or source** records a URL or private Drive file link, optional episode assignment (including Unassigned), already-cut/full-source intent, optional source-relative range, and why it matters. Source validation is shared with the server and never fetches a supplied link. Timestamps embedded in a URL are not imported as a range. Pending submissions appear under **Added by you**, separate from imported renders and the ready-for-review count. This phase has no connected processor, no upload endpoint and no playable manual-intake artifacts.

When the selected assignment has a configured private episode upload folder, the form opens that exact HTTPS Drive folder in a protected new tab. Users upload in Drive themselves and paste the resulting file link. Without folder configuration, the form explicitly reports direct upload unavailable. The dashboard does not create sharing permissions or claim to upload anything.

Source/range duplicates offer **Open existing** and a deliberate **Different cut** path; exact repeats cannot be forced through. Historical render duplicates are identified without opening a different current render. Pending records support editing, cancellation and restoration. Edit drafts keep their original expected revision, so a later server change conflicts instead of silently overwriting it. A conflict can explicitly discard edits and read the latest server record.

Create and per-record edit drafts are stored separately in tab-scoped session storage. An uncertain mutation retains its exact payload and idempotency key, including across reload. Its fields and Close controls remain locked until **Retry confirmation** resolves the same operation. If browser storage is unavailable, only the mounted form retains that request; keep the tab open until the result is confirmed. Successful saves clear only their own draft.

## Safety and consistency

Review writes include expected revision and a unique operation key. Network failures and 5xx responses reconcile through `/api/operations/:key` before reporting an uncertain result. Undo checks the exact render and committed revision. A new render cannot inherit a previous render’s draft or decision.

The native player loads only the backend’s allowlisted render endpoint, using the original when no proxy is available. It never autoplays. Verified render-relative transcript cues generate an in-memory WebVTT track and seek the clip timeline; unverified mappings cannot seek. Source-relative labels add the source-in offset only for display. Download and Drive links appear only when actual API metadata makes them available.

Hide and Restore change only review-queue visibility. There is no file deletion or production-resume action. Approval never changes airing evidence.

## Checks

Run `npm run lint -w @twib/web`, `npm run typecheck -w @twib/web`, `npm run build -w @twib/web`, and the root `npm test`.

Automated source/type/build checks are not a claim that private Google Drive, owner authentication or a real source file has been validated. `npm run test:browser` uses synthetic clips and mocked authenticated API responses to exercise desktop/mobile review, media, catalog polling, and interrupted refresh flows. It is a regression check, not private live-media acceptance; real-account and actual-source validation remain release gates.
