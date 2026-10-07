# Editorial workbench frontend

React + TypeScript + Vite. The charcoal/copper interface includes a responsive episode slate, focused review desk, optional keyboard actions, source context and separate editorial, production, QA, visibility and airing states.

## Local run

From the repository root, install with `npm ci` and start `npm run dev`. The Vite server binds to loopback at `http://127.0.0.1:5173` and proxies `/api` and `/media` to the local Worker at port 8787.

- `/` uses the real API contract, including session CSRF tokens and server-confirmed mutations.
- `/?demo=1` is available only on `localhost` or `127.0.0.1`. It uses fictional metadata and locally generated waveform SVGs. It never loads private media. Demo decisions stay in memory and reset on page reload.
- Unsaved note drafts are keyed to an exact render in tab-scoped `sessionStorage`, with an in-memory fallback if storage is unavailable. Drafts are cleared from storage after saving. Do not use a shared browser tab for confidential review.

## Safety and consistency

Review writes include expected revision and a unique operation key. Network failures and 5xx responses reconcile through `/api/operations/:key` before reporting an uncertain result. Undo checks the exact render and committed revision. A new render cannot inherit a previous render’s draft or decision.

The native player loads only the backend’s allowlisted render endpoint, using the original when no proxy is available. It never autoplays. Verified render-relative transcript cues generate an in-memory WebVTT track and seek the clip timeline; unverified mappings cannot seek. Source-relative labels add the source-in offset only for display. Download and Drive links appear only when actual API metadata makes them available.

Hide and Restore change only review-queue visibility. There is no file deletion or production-resume action. Approval never changes airing evidence.

## Checks

Run `npm run lint -w @twib/web`, `npm run typecheck -w @twib/web`, `npm run build -w @twib/web`, and the root `npm test`.

Automated source/type/build checks are not a claim that private Google Drive, owner authentication or a real source file has been validated. Browser/mobile/keyboard/media acceptance is a separate release gate. Local Chromium execution was blocked by the build environment’s socket restriction; cloud-browser access to loopback was also blocked. No visual screenshot or real-media acceptance pass is claimed for this environment.
