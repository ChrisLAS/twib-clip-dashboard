# TWiB private clip review

A local-first implementation of an owner-only episode review desk. React/TypeScript frontend, Cloudflare Worker backend, D1 metadata/event store, and a private Google Drive byte-range proxy. No deployment, accounts, credentials, source videos, or live producer integrations are included.

## Run locally

Node 24 and npm are recommended (SQLite-backed tests use Node's built-in SQLite).

1. `npm ci`
2. `npm run build -w apps/web` (Worker assets binding requires this directory)
3. `npm run db:local`
4. Terminal one: `npm run dev:worker`
5. Terminal two: `npm run dev`
6. Open `http://localhost:5173`.

If your home directory is unwritable, use `npm ci --cache /tmp/twib-npm-cache` and `XDG_CONFIG_HOME=/tmp/twib-config WRANGLER_LOG_PATH=/tmp/twib-wrangler.log` with Wrangler commands.

The local configuration explicitly enables demo mode only for localhost/127.0.0.1 requests. The default production configuration has no bypass. A request header cannot turn demo mode on. Demo records are entirely fictional examples, with synthetic timings, unknown source dates and no video. Local feedback persists in local D1. Demo stale events are labelled examples, not live producer progress.

## Checks

- `npm run check`: lint, TypeScript checks, unit/security/real-SQLite tests, Vite build, Worker dry-run bundle (does not deploy)
- `npm test`: deterministic credential-free tests
- `npm run build`: frontend build + Worker dry-run

See [implementation status](IMPLEMENTATION_STATUS.md) and [security review](security-review/REVIEW.md) if present. A successful build does not establish private live playback or deployment security.

## Architecture

- `apps/web`: review UI. Text uses React escaping; no remote HTML injection.
- `apps/worker`: authentication before all routes and static assets; API, media and controlled importer.
- `packages/shared`: typed API records. Production, editorial review, airing evidence and visibility remain separate.
- `apps/worker/migrations`: D1 append-only review/producer events and projections. Hide/Restore only; no Drive deletion operations.
- `docs/producer-contract.md`: producer import schema and invariants.

Every review belongs to an exact render ID. A new render starts unreviewed. Decisions are up/down/defer/clear plus optional reason and note. Defer is not a negative vote. No analytics or preference learning is silently applied. Airing remains unknown until separately verified evidence is implemented/imported; this build does not infer airing from a play, download, chapter title or approval.

## Production gate: do not deploy before these steps

1. Approve the Cloudflare account, hostname and expected costs. Create a private D1 database, replace its placeholder ID and apply migrations through an approved deployment process.
2. Configure an owner-only Cloudflare Access application at the exact hostname. Set `APP_ORIGIN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAIL`; securely supply a random `CSRF_SECRET` (at least 24 characters). Keep `APP_ENV=production`, omit `LOCAL_DEMO`, and retain `workers_dev=false`, `preview_urls=false`. Configure Access before the route becomes available. JWT issuer/audience/signature/expiry and exact owner email are checked in the Worker too.
3. Explicitly choose a NEW Google grant. Existing connected app tokens are not inherited. `drive.file` requires explicit selection of each existing/future media file and Sheet; selecting a folder does not grant its children. `drive.readonly` supports automatic reads but grants broad Drive read access beyond the folder allowlist. Do not create the OAuth client/grant or store refresh credentials until that persistent access is approved. OAuth consent/Testing seven-day refresh limitations must be reviewed. OAuth setup flow is not implemented in this app.
4. After approval, set only Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Never put them in D1, a manifest, frontend variables or this repository.
5. Configure one approved `PRODUCER_SHEET_ID`, bounded `PRODUCER_SHEET_RANGE` (e.g. `Manifests!A2:A101`), comma-separated `ALLOWED_EPISODE_IDS` and `ALLOWED_DRIVE_FOLDER_IDS`. Import only that private Sheet; there is no public webhook or arbitrary URL/file-ID endpoint. The file must be an immediate child of one configured folder, be downloadable, and match exact size, MP4 MIME and SHA-256.
6. Test wrong-account/logged-out/expired-token access on assets, API, media, production and alternate origins. Verify desktop and phone seeking beginning/middle/end, suffix/open ranges, full download SHA-256, upstream cancellation, no whole-file download before seek, Google token revocation/quota errors and proxy/original mapping. Real browser tests on actual authorized media remain mandatory.
7. Only then approve deployment. No deploy script, automatic deployment workflow, OAuth consent flow or external write integration is shipped.

## What this app does not do

It does not run or resume a producer, create clips, heartbeat a stalled process, infer ready-to-air, manage Google sharing, or delete Drive files. Poll/refresh observes stored events; it cannot restart work. A missed producer expectation is “status unknown,” not proof of a crash. Full listening/lip-sync is independent of technical QA.

## API essentials

GET `/api/session`, `/api/episodes`, `/api/episodes/:id`, `/api/renders/:id`, `/api/attempts/:id/events`, `/api/operations/:idempotencyKey`.

POST `/api/renders/:id/reviews`, `/api/clips/:id/visibility`, `/api/import`. Use same-origin JSON and `X-CSRF-Token` returned by the authenticated session. Review/visibility include `expectedRevision` and unique `idempotencyKey`. A timeout must reconcile GET operation before retrying the identical request. Reusing a key for changed content returns conflict. A stale revision requires refresh and a new deliberate decision.

GET/HEAD `/media/:renderId/original` or `/proxy`; optional `?download=1`. The server resolves artifact IDs internally; it never accepts client Drive IDs or URLs. Private responses are no-store/no-transform. Upstream response body streams directly.

## Design references

[Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Drive blob range downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [Sheets values.get scopes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).
