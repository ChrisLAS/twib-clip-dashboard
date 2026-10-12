# Metadata-only inventory pilot: implemented, not activated

The receiver now has a separately scoped machine-auth adapter. Repository defaults
remain disabled: no activation variables, credential, Access application/policy,
production migration or deployment are included. This document is an implementation
handoff, not approval to change live access or run a sender.

## One credential; independently bounded authority

Use one Number One Cloudflare Access service-token identity for the limited pilot
and subsequent approved production use. Offline tests use ephemeral synthetic keys
and dummy values. Do not create separate test/production/weekly credentials. Token
lifetime is an explicit provisioning decision; renewal is not automatic. The
server grant expires independently, so stopping the pilot does not require a new
credential. Revocation/rotation remains available if compromised.

A dedicated Access application must cover exactly
`/api/v2/number-one/inventory-snapshots` on the separately approved HTTPS origin.
Its dedicated audience must differ from the dashboard owner's audience. Use a
Service Auth policy for the exact service Client ID; leave the owner application,
owner identity and all other routes unchanged. Verify the organization's current
service-token authentication behavior rather than modifying organization-wide
settings. Broader path rules, Bypass/Allow fallbacks or owner-cookie reuse are not
part of this plan.

The Worker trusts only the signed `Cf-Access-Jwt-Assertion`. It verifies RS256 with
JWKS at the configured Cloudflare Access team issuer, exact issuer and one-element
application audience, required/current expiration, integer issued-at, app token
type, exact signed `common_name`, empty `sub` and absent email. JWT age is at most
15 minutes, lifetime at most one hour, future issued-at tolerance 60 seconds; nbf
is honored. Proposed Access app session duration is 15 minutes. The sender sends
Client ID and Client Secret headers on each request, never a cached owner cookie.
Raw client headers, email headers and cookies alone have no authority at the Worker.

These claims follow [Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#service-token-authentication).
Service-token provisioning is separately described by [Cloudflare](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Private configuration, no default activation

All must be privately set only after the exact live access/deployment change is
approved. None is present in tracked Wrangler configuration:

- `INVENTORY_INGEST_ENABLED`: exactly `true`; absent/other values stay disabled.
- `INVENTORY_APP_ORIGIN`: canonical HTTPS origin, no path, port or credentials.
- `INVENTORY_ACCESS_TEAM_DOMAIN`: approved `*.cloudflareaccess.com` team.
- `INVENTORY_ACCESS_AUD`: dedicated 64-hex application audience, not `ACCESS_AUD`.
- `INVENTORY_ACCESS_CLIENT_ID`: exact service Client ID ending in `.access`.
- `INVENTORY_GRANT_STARTS_AT`, `INVENTORY_GRANT_EXPIRES_AT`: fixed absolute dates;
  expiry is after start and at most 24 hours later. Never recompute/extend per request.

Existing owner `ACCESS_AUD` must remain configured. The adapter does not read or
store the service Client Secret. No new application signing secret is needed.
Missing/malformed config returns 503; expired/future grant returns 403; invalid
machine JWT/destination/method returns 401. All precede body reading and DB access.
Only exact POST on the configured origin/path without query is eligible; v1 and
sibling reserved paths stay disabled. Owner/demo/Drive/MCP auth never substitutes.

The server constructs the grant, never the request: source `nomad:number-one`,
show `twib`, episode 127, ID
`episode_616a1ec58e997fd5fb97fa27ec48153b57e83418ab576c463c537533a6f29e72`,
`inventory:write`, fixed expiry, no origin hosts and no editorial context.
All item origins must be `[]` and all observation contexts `{}`. The receiver
rejects unprojected payloads rather than scrubbing and acknowledging a changed
payload. Prepare the reviewed projection before hashing/allocating an immutable
producer envelope. Policy omissions get truthful sanitized diagnostics and
`complete=false`; accepted refs and IDs remain exact.

Limits are unchanged: 1 MiB uncompressed whole envelope, 2,000 items, 32 KiB/item,
100 observations/origins/evidence per item, depth 16, 4,000-character strings.
Validation and exact episode binding occur before any DB access. Only a durable
commit/readback returns HTTP 200 with the v2 receipt; exact replay returns the
original receipt. Errors contain fixed codes/messages, no submitted metadata.
Receipts are bounded metadata (tested below 4 KiB), private/no-store. No media,
readiness promotion, delete, shell, job, scheduling or workspace remapping is added.

Receiver inventory has no automatic TTL or cleanup. Stored history/receipts stay
retained pending a separately approved retention policy; 24 hours limits authority,
not data lifetime. No deletion or cleanup is included in this pilot.

The one-real-snapshot pilot is an operational bound on the manual sender, not a
receiver write-count quota. The grant authorizes valid scoped writes throughout
its fixed window; do not represent it as a one-use credential or receiver quota.

## Manual pilot sequence after separate live approvals

1. Review the exact receiver/sender commits and synthetic checks. Install the
   `cfast_` conformance extension on both sides before provisioning any live secret.
2. Approve the exact Access application/Service Auth policy, one service identity
   and lifetime, secure installation destination, and private grant timestamps.
   Credential creation and entry require the supported secure/user handoff; never
   put a real value in chat, GitHub, command arguments, fixtures or logs.
3. Separately approve migration/deployment and the manual pilot. Preserve the
   existing durable source/episode stream; never reset sequence state or create a
   second test stream using the same identity. No service/timer is activated.
4. Prepare one zero-item, incomplete synthetic snapshot using the stream's normal
   next sequence. Send manually, then exact-replay the same persisted envelope.
   Verify the matching durable receipt and unchanged receipt ID on replay.
5. Prepare/review one real episode-127 metadata-only envelope; manually send it,
   reconcile source/episode/scan/sequence/digest/count and owner readback, then stop.
   Do not assume a fixed discovered-item count. Older/omitted items are retained.
6. Stop by disabling ingestion or letting the fixed grant expire. Keep the one
   credential for later approved use; continuing/expanding authority requires a
   separately approved grant/rollout. No automatic extension, pruning or scheduler.

Offline signed-JWT/SQLite tests validate the adapter and durable response path;
they do not prove the live Access routing, JWKS delivery, installed credential,
production schema or Nomad network path. Those remain the explicit pilot gates.
