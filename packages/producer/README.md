# Local resumable media producer

**Implemented and tested locally, not connected to the live dashboard queue.** This package never reads an owner cookie, creates credentials, uploads to Drive, edits a Sheet, or performs transcription. Do not deploy CPU-heavy processing in the Cloudflare Worker.

## Requirements and quick start

POSIX host, Python 3.10+, official FFmpeg/ffprobe with libx264 and AAC. No Python dependencies. Run under a dedicated low-privilege OS account with private input/state directories. Do not use a shared/network filesystem or let untrusted local users edit these directories. ffmpeg is a media parser, not a security sandbox: production should additionally use an isolated, non-networked container with host resource limits and current patched tools.

```sh
python3 -m unittest discover -s packages/producer -v
python3 packages/producer/producer.py /private/job.json \
  --input-root /private/approved-inputs --state-root /private/producer-state
```

A job (fill exact hashes using sha256sum; example values are placeholders):

```json
{
  "schemaVersion": 1,
  "jobId": "intake-123-render-1",
  "clipId": "clip-123",
  "episodeId": "episode-123",
  "title": "Approved clip title",
  "summary": "Approved immutable summary",
  "narrativeRole": "analysis",
  "input": {"path": "source.mp4", "sha256": "EXACT_64_LOWERCASE_HEX"},
  "mode": "cut",
  "sourceInMs": 12000,
  "sourceOutMs": 42000,
  "transcript": {"path": "transcript.json", "sha256": "EXACT_64_LOWERCASE_HEX", "basis": "source"},
  "version": 1,
  "previousRenderIds": []
}
```

Transcript file: ordered array of `{ "startMs": 12100, "endMs": 14000, "text": "Actual supplied transcript text." }`. Source-basis cues are shifted by sourceInMs. Clip-basis cues already start relative to the requested clip. Cues crossing a cut boundary block processing instead of falsely assigning whole text to a shortened time span. Provide word-level cues or an explicitly corrected timed transcript. Empty/missing transcripts block. No text is invented.

`already_cut` means the asset is already the requested interval: **sourceInMs/sourceOutMs still refer to the original recording**, not zero-based clip time. Its measured duration must agree within 100 ms. This does not independently establish that the supplied original time offset is truthful. The render is still a new H.264/AAC derivative; the exact input is preserved as source.media. The output gets its own content hash and render identity. Never relabel a source file as a new render under an old hash.

Source metadata options: sourceTitle, sourceUrl (HTTPS), speaker, edition, recordingDate, publicationDate, context. These are supplied provenance, not inferred verification. A render longer than 180 seconds needs `longException` text; hard maximum is 15 minutes. The rationale is preserved as longException in the local bundle for inspection. This is an explicit editorial decision. ffmpeg cannot determine complete thoughts, context, rights, listening quality or lip sync.

## Resume and durable state

The immutable canonical job fingerprint binds source/transcript hashes, range, metadata and render history. Reuse exactly the same job to resume. A changed job with the same jobId is refused; use a new job/version and retain prior renderIds when producing a deliberate revision.

Each job directory contains:

- state.json: authoritative atomic snapshot of job/attempt/status/checkpoints and append-only event history
- events.json: derived replayable event/activation export, repaired from authoritative state on resume
- lock: kernel flock; held across child media processes, released on process death
- source.media: SHA-verified copy of the original input, never modified by rendering
- render.mp4: derived render, rehashed on every resume
- bundle.json: local output metadata, relative timed cues, edit map, technical QA, manifest template and pending-upload artifact description

Every committed file checkpoint has SHA-256 and size; all checkpoints are revalidated on resume, including already-completed runs. Corruption blocks rather than trusting an old stage marker. Temporary partial downloads/renders are not checkpoints and are safely overwritten. No partial output is presented as complete. Re-running a completed job returns the same bundle without rerendering or extra events.

`--stop-after source` or `--stop-after render` performs a controlled restart drill. Tests also send actual SIGKILL during rendering, then resume. Orphan ffmpeg inherits the job lock so a second process cannot overwrite its output before it exits. The lease record is diagnostic host/PID/acquired time, **not a multi-host expiring distributed lease**. The kernel lock is the authority. An event is emitted for measured checkpoint completion; routine refreshes are not progress.

A blocked job stays blocked until an operator fixes the cause and invokes `--retry`. That creates a new attempt with an explicit supersedes chain. It does not bypass permissions or alter input hashes. 401/403, network issues and parser errors are not automatically retried. Events are capped below the importer's 2,000-event limit. These exports target one clip's ownership chain: do not run unrelated job IDs for the same clip concurrently. Existing dashboard attempts require the correct `supersedesAttemptId`; the server rejects conflicting activation history.

## Bounded acquisition and media processing

Local assets must be within --input-root; symlinks are refused. Source SHA-256 is mandatory. HTTPS download uses `input.url` in place of path, plus one or more **operator-supplied** `--allow-host example.org` arguments. Job content cannot approve hosts. No network requests are made unless the operator provides that exact allowlist. Source pages are not media extractors: use a permitted direct media URL; no DRM, anti-bot, login or 403 bypass.

Only HTTPS port 443, no URL credentials, no cookies/proxies/auth headers. Every redirect is checked (at most three), all resolved addresses must be public, and the connection pins a validated IP while preserving TLS hostname verification. Two GiB byte cap, 180-second overall download budget and 15-second socket inactivity timeout. Source duration <= six hours, video <= 4096x2160, bounded tool CPU/address space/output sizes. ffmpeg gets argv arrays (no shell), a small demuxer allowlist, file/pipe-only protocols, no source metadata/chapter copying, two encoding threads and ten-minute tool wall-clock timeout. Final output receives ffprobe checks and a full error-fatal decode. Input files remain local to the host; URLs and source media are never executed as commands.

The default producer has no external transcription adapter. A future adapter must be an explicitly configured trusted executable/provider with its own authorized data sharing, bounded timeout, and timed/hash-tied output. User-submitted jobs must never carry shell commands or arbitrary executable names.

## Manifest bridge and integration boundary

The bundle is **not directly importable**: artifacts is empty until an authorized uploader writes the exact render to the already-approved Drive folder. Its original artifact means the review's main render, not the full-length preserved input. After authorized upload, supply an upload receipt:

```json
{"fileId":"ACTUAL_DRIVE_FILE_ID","size":123456,"sha256":"EXACT_RENDER_SHA256"}
```

```sh
python3 packages/producer/finalize_manifest.py /private/producer-state/JOB/bundle.json \
  /private/upload-receipt.json --out /private/new-manifest.json
```

Finalization verifies the completed bundle checkpoint, rehashes the local render and verifies receipt size/hash. It publishes through a unique exclusive temporary file and atomic no-clobber link: existing destinations and unrelated sibling files remain unchanged, including when two exporters race. It only writes a local JSON file. It does **not** verify Drive folder membership or perform the upload: the dashboard importer independently checks the configured Drive folder, MP4 metadata and bytes. Append the resulting JSON as a new immutable cell in the approved Sheet only through an authorized uploader; never rewrite accepted rows. New episodes must already exist or be included separately with their exact immutable approved metadata.

Local technical-ready events mean local bundle QA completed; they do not prove upload/import/availability. The dashboard requires artifact records and hash-tied technical QA in addition to events. Listening, lip-sync, source-date, context, rights and complete-argument remain explicitly unknown. No airing match is inferred.

The existing private `manual_intake` table is owner-managed planning, not a worker lease queue. This CLI consumes exported JSON jobs; it does not claim that table, use owner cookies, forge auth, or mark the dashboard producer connected. A future authorized host needs a narrow claim/report API with machine identity, revision fencing, renewable durable leases, idempotent result reporting and cancellation checks. Preserve local job/checkpoint identities when adopting that API. This package's local locking is insufficient for multi-host queue ownership.

Remaining deployment decisions: approved producer host and persistent runtime; narrowly scoped machine authentication; authorized Google output-write identity/folder and Sheet appending; actual transcription runtime; source ingestion policy and editorial range review. None were silently configured by this implementation.
