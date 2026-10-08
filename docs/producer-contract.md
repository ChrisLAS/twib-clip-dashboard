# Producer manifest bridge

The Sheet has one complete JSON manifest per cell in its configured A-column range. Append immutable manifests rather than editing old rows. The server checks the approved catalog every five minutes through its scheduled handler; authenticated owner POST /api/import remains a troubleshooting path. Both share the same import lease. There is no producer control endpoint. A bounded Sheet range prevents unbounded historical pulls. A durable incremental/archival mechanism is a future requirement once that bound is reached.

The authoritative validation schema is `apps/worker/src/importer.ts` (`manifestSchema`). Envelope fields: schemaVersion=1, episodes[], clips[], renders[], artifacts[], events[], activations[]. Empty arrays are valid. All IDs are stable alphanumeric/hyphen/underscore strings, timestamps RFC3339 UTC/offset strings, and offsets integer milliseconds. Do not use row numbers or filenames as identity.

- Episode records describe display metadata; IDs and imported snapshots are immutable.
- Clip records identify episode, currentRenderId and full renderIds history. Imported title, summary and narrativeRole are immutable; changing them under the same clip ID is an explicit conflict, not a silently ignored update. Subsequent manifests retain all history and can advance currentRenderId only to a higher version belonging to the same clip. Hide/reviews are not producer-owned.
- Render records are immutable. Source recording/publication/retrieval timestamps remain separate. Cue times are render-relative; mappingVerified permits seeking. No guessed source timestamp offsets. Changes require a new render ID/version.
- Artifact records have renderId, original|proxy kind, approved Drive fileId, byte size and lowercase SHA-256. Google metadata and immediate parent-folder membership are checked before storing. No media bytes are committed.
- Producer events contain schemaVersion, id, attemptId, clipId, sequence, occurredAt, stage, state, progress, nextExpectedAt, blocker, checkpoint. Set progress=true only for actual measured progress. Refresh/import is not a producer event. A blocker needs an actual reason. Future timestamps beyond clock skew are rejected.
- Activations identify clipId, attemptId and supersedes (null only for an initial attempt). A delayed old activation cannot replace a newer attempt. Old events stay in history and do not project onto active state. Checkpoint strings are evidence only; no resume action is offered.

Technical review readiness requires original media, verified timeline mapping and hash-tied passed QA with exact check IDs `artifact`, `container`, `codecs`, `duration`, `mapping`. A producer ready event alone is insufficient. Additional `listening`, `lip-sync`, `source-date`, `context` checks remain separate and may be unknown.

A SHA-256 receipt of the parsed manifest is committed with all changes in one atomic D1 batch. Repeated identical manifests are skipped before projection checks. Event IDs and per-attempt sequence numbers deduplicate; changed content under an existing event/render/artifact ID is rejected. Batch failure preserves the previous committed state. A subsequent manifest can refer to earlier committed clip/render IDs. Imported references and attempt ownership are validated, with database triggers defending collisions.

Recovery: fix invalid unimported data; create a new immutable manifest for new work. Never rewrite an already accepted event. A new attempt names the old attempt in supersedes and reuses only fingerprints verified by the producer. Import errors remain visible with the last successful sync timestamp. Partial Sheet progress is possible across manifests: each manifest commits atomically; failure in a later row preserves earlier committed rows and receipts for a safe retry.

Current limitation: airing-evidence ingestion and general metadata correction events are not implemented. No confirmed airing is inferred or editable through this build. Production deployment requires reviewing this contract against one real producer manifest and the actual cut hashes.

## Appending clips safely

1. Keep accepted cells unchanged. Append a new JSON manifest cell inside the already approved bounded Sheet range. The envelope has no `snapshotId` field: its SHA-256 content receipt is its identity.
2. For a new clip, allocate a new stable clip ID, render ID and applicable producer event/attempt IDs. Use the existing approved episode ID. Omit unchanged episode records or copy their original immutable values exactly; the displayed clip count is derived from stored clips.
3. Supply the clip, its complete render metadata, and its original/proxy artifact records. The approved private Drive folder, MP4 type, exact size and SHA-256 are verified for new imports. Do not substitute a URL or relax the allowlists.
4. To advance an existing clip, append a manifest retaining all previous render IDs and advancing `currentRenderId` to a new, higher render version. Keep the clip's original title, summary and narrativeRole. Reviews stay bound to their original render, and a new render starts unreviewed.
5. Wait for the next successful sync and check the catalog status. The open dashboard announces available catalog changes; explicitly apply them from the slate. Do not rewrite accepted records to clear an error. If a correction needs changing immutable metadata, stop and arrange a deliberate correction workflow; this bridge does not implement general metadata correction events.

Repeated accepted manifests do not advance catalog versions or recheck every artifact. New or changed manifests still undergo validation; ordinary media requests independently revalidate their approved artifacts. Sync does not read a feed, create clips, run a producer or confirm airing.
