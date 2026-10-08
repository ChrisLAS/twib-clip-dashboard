# Verification record

This package was verified in the provided cloud filesystem with Python 3.12.14 and FFmpeg/ffprobe 7.1.5. All media is generated synthetic testsrc/sine fixture content; no user media or private account access was used.

## Passed

- `python3 -m unittest discover -s packages/producer -v`: 14 tests
- `npx vitest run packages/producer/producer.test.ts`: 2 tests (executes the Python suite and validates a real finalized render manifest against the authoritative dashboard Zod schema)
- Actual H.264/AAC cut render, ffprobe and full ffmpeg error-fatal decode
- Already-cut rendering with original source offset preserved and clip-basis cues
- Actual SIGKILL during rendering, restart after inherited process lock release, no duplicate output file or event sequence
- Controlled render-checkpoint stop/resume without rerendering
- Injected power-loss window before bundle commit; no prematurely committed ready status
- Completed-job repeat returns identical bundle bytes
- Input/transcript hashes, corrupted checkpoint refusal, immutable job collision refusal
- Explicit retry creates a superseding attempt with retained event history
- Local lock exclusion, input/state symlink refusal, approved input-root containment
- Mocked host allowlist, private IP, 403, redirect-to-unapproved-host and byte-limit refusal
- Wall deadline interrupts simulated slow-drip header wait
- Long-exception requirement and cut-boundary transcript cue refusal
- RFC3339 timestamp grammar rejects Python-only ISO variants and invalid dates; accepted timestamp metadata passes authoritative schema
- Final-export sibling preservation and concurrent no-clobber publication
- Inspectable editorial longException retained in local bundle
- Finalized upload receipt exact size/hash checks, corrupted bundle refusal
- Source-relative cues correctly shifted to render time; unsupported human/editorial QA remains unknown

## Not exercised or configured

No live HTTP media download, real source/cut, Drive upload, Sheet append, dashboard import, live worker queue claim, machine credentials, transcription service, continuous producer deployment or source/rights/editorial validation. Mocked network refusal tests are not an end-to-end network certification. The actual dashboard integration test checks schema compatibility, not private Google ownership or a deployed import.

A production operator must validate a representative authorized real source, inspect/listen to the render and transcript, verify upload/import in the approved private catalog, and approve/configure the host and narrowly scoped access before calling this producer live. Multi-host distributed leasing is explicitly out of scope for the local flock implementation.
