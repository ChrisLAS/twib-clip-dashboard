# Editorial context and feedback

## Safety and provenance

Migration 0006 contains no private profile data. The initial profile is empty. Owner-approved private bootstrap uses the authenticated profile mutation API, with its explicit reason and idempotency key; never commit that request or its private output. A producer must load context before research, selection, cutting, or rendering and record actual use only afterward. Reading the context does not prove consumption or change selection.

Existing review votes are examples, not permanent tastes. An approval or rejection with empty reason/notes contributes no inferred rule. The context reports this coverage explicitly. Exact-render notes stay attached to that render. A new proposal is pending and nonbinding until the owner explicitly confirms it. `episode` means this episode only, `global` means future work across episodes, and `render` means exactly the specified render in the specified episode. Confirming a proposal must retain its scope and targets.

Profile version is the mutation expectedRevision. All accepted profile and feedback edits create immutable evidence events with authenticated owner principal, operation key, reason, scope, and the full resulting projection. Undo writes a new version, restores only that earlier version's approved rules/enabled flag, and never deletes feedback or proposal history. Disabling projects no rules. Changing owner identity does not grant access to another profile.

## API

All routes use existing Access authentication; mutations also require existing CSRF validation. Responses are private/no-store. GET /api/editorial/profile returns EditorialProfile. GET /api/editorial/context?episodeId=…&renderId=… returns EditorialContext. GET /api/editorial/history returns up to 100 immutable event summaries and receipts. POST /api/editorial/profile and POST /api/editorial/feedback accept the exact shared input contracts in packages/shared/src/editorial.ts. POST /api/editorial/receipts accepts EditorialReceiptInput.

Every mutation uses a durable idempotency key; reusing it with different content fails. A stale expectedRevision fails with 409. Retry uncertain saves with the original request and key, not a newly constructed operation. The UI keeps pending requests and local drafts in session storage across navigation. GET never creates a receipt.

A load/use receipt records stage (research, selection, cutting, rendering), exact profile version/context hash, used rule IDs, evidence IDs, actor (owner or assistant), explanation, and explicit changedBecauseFeedback. A true change requires both used rules and linked feedback evidence. An empty profile or unreasoned vote alone cannot substantiate the claim. Evidence must belong to used rules. The backend verifies structural claims against the immutable version, but does not observe an external model's cognition: receipts are clearly attested `caller_reported`. `loadedStatus: reported_loaded` means a matching caller-reported receipt exists, not independent proof. A later version does not inherit a previous version's loaded status.

The context hash covers only the canonical approved-rule projection; review examples, coverage, and latest receipt are supplementary metadata and are not part of that hash. Historical receipts remain valid even as supplementary metadata changes.

## Credential-free connector read

The weekly assistant must not fabricate an Access cookie, reuse owner browser credentials, or provision an API token merely to read editorial context. An already-authorized Cloudflare D1 read connector can retrieve the same data. Bind the verified existing Access subject principal (the exact value returned by authenticate and stored in review_events.reviewer) and current episode/render IDs; do not interpolate untrusted source text into SQL.

```
SELECT data FROM editorial_profiles WHERE owner = ?;
```

Missing row means `{version:0,enabled:true,rules:[],feedback:[],proposals:[],updatedAt:null}`. Run the exported `editorialContextValue(profile, episodeId, renderId)` from packages/shared/src/editorial.ts. Hash `JSON.stringify(value)` with SHA-256 and lowercase hexadecimal encoding (identical to worker store.fingerprint). This pure canonical builder filters enabled approved rules by exact scope, sorts rule IDs and each rule's evidence IDs, and returns a sorted evidence union. Pending proposals do not participate.

Supplementary review examples use the exported `editorialReviewExamplesSql` in apps/worker/src/editorial.ts with bindings `[verifiedOwnerPrincipal, episodeIdOrNull, renderIdOrNull]`. This query includes relevant past episodes so a new workspace does not erase earlier evidence. It selects only the latest event for each exact render and excludes cleared decisions; older approvals/rejections cannot reappear after a clear or later decision. It interleaves decision classes to retain positive and negative evidence, prioritizing the requested render/episode and current renders within each class. Keep the first 100 and expose truncation when row 101 exists. Origin episode, exact render, and current/historical flags remain explicit. Count blank reasons only when both reason and note are whitespace or empty. No preferences are inferred. To copy the SQL for a connector, use that exported constant verbatim rather than an independently changed filter.

Latest reported use for this exact canonical context:

```
SELECT data FROM editorial_receipts
WHERE owner = ? AND json_extract(data, '$.contextHash') = ?
ORDER BY created_at DESC, id DESC LIMIT 1;
```

This connector path is read-only. If no authorized receipt-write path is available, report that the context was loaded and which explicit rules were used in the assistant's own run output, but do not claim a dashboard receipt was persisted. Never insert a synthetic receipt merely to make the UI look connected.

## Validation

apps/worker/test/editorial.test.ts covers empty initialization, blank feedback, proposal confirmation, receipt claims, owner isolation, immutable undo, exact-render target checks, scoped deterministic projection, revision races/idempotency, and nonexistent evidence. Dashboard component EditorialPanel lazily loads when expanded; it never emits producer-use receipts.

## Explicit-instruction administrator bootstrap

An already-authorized administrator connector can apply a separately reviewed, private starter profile without fabricating an owner HTTP session. Migration0009 adds an explicit event actor. The pure `prepareEditorialBootstrap(rawRequest, verifiedOwnerPrincipal)` helper in `apps/worker/src/editorial-bootstrap.ts` accepts only revision-zero replacement of explicit global rules with no invented feedback IDs; it returns the bound SQL statement, immutable projection, request fingerprint and reconciliation query. It does not execute SQL or grant access. Private instruction content must remain outside the repository.

Before executing, independently verify the exact existing Access subject in review_events.reviewer and that the owner's profile/history is empty. Have the coordinating operator review the exact instruction payload and authority. The SQL atomically requires an existing review principal and a fresh empty profile/history; the normal editorial event trigger applies revision fencing. Its actor is `assistant_bootstrap`, not `owner`. A repeated/no-op statement is not proof of success: run the returned reconciliation query and require identical request fingerprint, actor and profile. A different existing profile or key must be reported and never overwritten. Read back version1 and the canonical context. No HTTP token, machine identity or new persistent permission is created.
