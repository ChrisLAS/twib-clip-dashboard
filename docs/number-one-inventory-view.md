# Owner inventory workspace

The **Source inventory** entry opens a read-only workspace at `?view=inventory`.
It is separate from the curated episode slate, playback and editorial decisions.
The pilot inventory scope is explicitly registered as `nomad:number-one / twib /
127`; its selector is independent from the currently selected curated episode.
There is no heuristic mapping by filename, URL or current dashboard episode.

## What the page establishes

- Counts cover the latest retained observation of every inventory identity,
  including records absent from later partial snapshots.
- Processing-state filters and literal ID/reference search run on the server,
  before 20-record keyset pagination. Search does not mean “search loaded page.”
- Capture observed means source capture evidence was reported. It does not mean
  QA passed, playback is available, or a clip is ready for editorial review.
- Received time is the latest durable receipt arrival. Source-observed time is
  the clock on the highest-sequence producer snapshot. These are not heartbeats.
- The receiver gate indicates only its explicit configuration flag. An open gate
  does not prove that a producer is running or that every private grant is valid.
- A partial latest snapshot and partial candidate coverage are distinct. Neither
  authorizes deletion. Latest scan receipt details and per-record provenance
  make this limitation visible.
- URLs and editorial context are not displayed. References are escaped literal
  text, never playable links or HTML. Capture hashes/stream verification are not
  inferred from producer metadata.

## API

Owner authentication precedes `GET /api/inventory` reads. New optional parameters:

- `episodeNumber=127`: explicit registered pilot scope; other numbers return
  `INVENTORY_EPISODE_UNMAPPED`. Existing exact `episodeId` remains compatible.
- `status`: one of the shared `INVENTORY_STATUSES` values.
- `q`: up to 200 characters, literal substring over record IDs and relative
  media/observation/evidence artifact references. It never searches editorial
  context or source URLs.
- `after`: existing bounded keyset cursor.

The response adds server totals, filtered totals, exact status counts, latest
receipt/source timestamps and per-record receipt provenance. It performs four
bounded-result SQL queries; no client-side load-all is required.

Readiness remains `not_evaluated`; the API does not write producer state, infer
clip readiness or refresh the producer. **Refresh stored records** only repeats
an owner read. There is no scheduler, ingest activation, media upload or migration
in this UI change. The existing `INVENTORY_INGEST_ENABLED` setting is untouched.

## Verification

`npm run check` covers aggregate worker/web tests, lint, TypeScript and builds.
`npm run test:browser` includes `security-review/inventory-browser-regression.mjs`
with synthetic metadata, desktop/mobile screenshots, server-filter/pagination
fixtures, keyboard expansion, read/session failure and interrupted navigation.
The existing clip-review browser regressions remain in the same suite. Fixture
screenshots are saved under `test-results/inventory-*.png`; they contain no real
producer filenames or source records.

The inventory entry is unavailable during active clip review. Review drafts and
slate filters remain in their existing state; navigating between the two
workspaces does not submit editorial changes. Browser Back/Forward restores the
workspace view, and obsolete inventory reads are aborted/ignored.

## Reporter and media/review grouping

The reporter is **Number One on Nomad**. This identifies who submitted the
inventory, not who downloaded or created each file. The latter is unknown in
this metadata; manually copied or synchronized files are not attributed to an
agent without evidence.

The UI defaults to **Media files**. Research candidates and records needing
review remain one click away, with visible counts; **All inventory** retains the
original ungrouped view. Counts are global, not just the loaded page.

`group=media|research|attention|all` is an optional owner-read parameter; omission
defaults to `all` for API compatibility. The group is combined with status and
search before pagination. Media requires a source-observed media file with
`captured_observed` status and a recognized audio/video suffix. Candidate-kind
records in candidate status are research. Everything else is needs review,
including failed, partial, quarantined, missing, unverified and ambiguous records.
This is a presentation classification, not a change to source status/readiness.

A filename is only a format hint. MP4 video is preferred, but an MP4 suffix does
not verify codecs or playback. Existing WebM remains visible with a conversion
preference flag; it is not renamed, converted or marked failed. Audio formats
are not flagged solely because they are not MP4. A `.part` suffix cannot enter
the main media group. No records are deleted or silently dropped.

The needs-review section explicitly says re-download requests are not connected.
There is no pretend retry control, producer write or new credential permission.
A future retry workflow needs a separately reviewed job contract, exact source
identity, owner authorization, durable request/acknowledgement and producer
results before the UI can truthfully offer that action.
