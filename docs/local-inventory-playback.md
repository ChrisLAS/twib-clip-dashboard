# Explicit local inventory playback

This document describes the historical playback-only base. The current review
candidate adds persistent notes, row decisions and an unapplied database
migration; see [Inventory row review](inventory-row-review.md).

This update is stacked on the media-first inventory view at04ca4d3. Deploy its
PR3 grouped inventory-read API with the frontend; assets alone cannot use the
earlier response without groupCounts. No database migration, credential change,
producer activation or CSP change is needed. Existing media-src permits self/blob.

Choose the workstation's synced episode folder named127. The browser compares
literal episode-relative references and observed size, never URL-decodes percent
characters or guesses by basename. Conflicting/truncated observations, duplicate
matches, partial/unknown files and non-captured records cannot open playback.
Their review records remain available. Individual files require typing the full
reference to make an explicit manual binding; browsers hide the parent directory.
Neither route verifies content identity or a producer hash. Mtime is advisory.

Native video/audio controls use browser-only object URLs; nothing is uploaded or
relayed and no local listener is created. Codec/read errors do not change capture
status or editorial readiness. Playback position and private tab-only draft notes
survive unchanged refreshes and partial/page omissions. Hiding inventory pauses
the mounted player. Replacement, invalidation, close and unmount release URLs.

Files are browser snapshots, not a live sync watch. Reselect after sync changes;
same-size replacements are undetectable without independent hashing. Reload loses
selection grants and session notes. There is no automatic disk-path reopening or
saved editorial note in this slice.

## Validation

Run npm run check for schema freshness, lint, types, full tests, frontend build and
Worker dry-run packages. Run node security-review/local-playback-regression.mjs
with installed Chrome, Firefox and ffmpeg on Linux for23 assertions per desktop
Chrome, mobile Chrome and Firefox. The harness generates synthetic MP4/audio,
uses fresh browser profiles and self-contained file URLs, and opens no listener.
It tests programmatically selected Files, decoding, literal mappings, unchanged
refresh/partial preservation, view toggling, drafts, codec errors and URL release.
It does not test an actual native OS folder picker, real episode codecs or sync
arrival. Jobs and ingestion remain disabled; this change provides no job controls.

Use the existing docs/embedded-worker-packaging.md workflow for deployed frontend
packaging. Preserve existing platform bindings, schedules, access policy and
closed ingestion gate; never deploy placeholder repository database IDs.
