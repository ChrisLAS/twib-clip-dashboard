# Isolated MCP connection probe (staged, not deployed)

This Worker intentionally has no dashboard import, production DB, Drive binding, media route, review operation or job control. The only MCP tool is `get_integration_status`: probe build version, an independently generated opaque owner ID, and a new random nonce. A successful local test or Inspector session is not acceptance: the owner must connect the deployed server in their custom MCP interface and Chad must actually call this tool from that conversation.

## Proposed deployment, requiring explicit approval

- Host: `https://clips-mcp.jbnet.vip`; MCP resource: `https://clips-mcp.jbnet.vip/mcp`.
- One new Worker: `twib-mcp-probe`. Keep `workers_dev=false` and `preview_urls=false`.
- One new private KV namespace, bound only as `OAUTH_KV`, for short-lived OAuth registrations, consent, grants and tokens.
- One new SQLite Durable Object namespace/class, `ReplayGuard`, for hashed one-time markers. Objects are allocated per consent/grant marker and clean up after 24 hours. It is needed because the library's KV alone is eventually consistent and cannot guarantee atomic redemption.
- One new Cloudflare Access application covering ONLY `clips-mcp.jbnet.vip/authorize`, with owner-only allow policy using the existing identity provider. No changes to the dashboard application, its policy, hostname or existing audience. Verify subpath matching and block unauthorized identity before connecting.
- OAuth discovery, registration, token and `/mcp` routes cannot sit behind blanket browser Access. `/mcp` instead requires the OAuth token and performs exact owner, scope and audience checks. No public route reaches dashboard data.
- Copy the new Access audience, existing Access team domain, owner email and a random opaque owner identifier into private deployment configuration. Do not commit private values. No Access service tokens or production Google credentials are used.
- Copy the exact callback URI shown in ChatGPT's custom MCP management interface into `ALLOWED_REDIRECT_URIS` (comma-separated if more than one explicitly approved URI). The current RFC 9207 callback documented by OpenAI is `https://chatgpt.com/connector_platform_oauth_redirect`; confirm the actual interface value before configuration. Dynamic registration accepts only these exact callbacks; CIMD additionally validates the metadata document. A client name alone is not trusted.
- Update the local ignored deployment config's origin and real KV namespace ID after approval; checked-in placeholders fail closed. No custom domain, Access policy or resource provisioning is performed by this patch.
- Uses the existing Cloudflare account/plan only if Workers, KV and SQLite Durable Objects are available within approved usage. Current account entitlements and incremental metering are NOT verified by local tests. Stop and report if a new paid resource commitment/plan change is needed; no new subscription is authorized here.

Creating the Access application, hosting routes, storage and the user's OAuth grant expands persistent access and remains an explicit approval/handoff step. Approval to build this local patch does not authorize deployment, publication or any grant. Signing in and pressing Allow are performed by the owner. No credentials should be pasted in chat or source.

## Auth boundaries

Cloudflare's maintained `@cloudflare/workers-oauth-provider` 1.2.3 handles OAuth, PKCE, browser-bound consent, encrypted grants, discovery and token validation. The official MCP SDK implements stateless HTTPS Streamable HTTP. Local hardening adds exact resource/redirect/scope checks, universal S256, bounded request bodies, owner-only Access JWT verification on both consent requests, and atomic replay markers. Fresh Allow/Deny consent is always shown; no remembered-consent shortcut. Returned identity is an independent opaque value, never the email or Access subject.

Access tokens expire after 600 seconds and refresh tokens are disabled. This is deliberate for a connection test: reconnect after expiry. Consent and code expiration are also 600 seconds. Revocation on validated code replay is supplemented with a strongly consistent guard checked before serving MCP; no raw code/token is stored in the guard. Calls already in flight can complete. Standard RFC 7009 disconnect revocation still uses the library’s eventually consistent KV, so global revocation is not instantaneous; the short token lifetime bounds residual exposure. Availability failures fail closed. KV propagation can require restarting a failed initial authorization; do not weaken validation to make a retry work.

Tool annotations are read-only and non-destructive. `idempotentHint` is false because the nonce changes on every call. No external API calls are made by the tool itself. Access verification fetches only the configured Cloudflare JWKS; CIMD fetch is constrained by the provider and `global_fetch_strictly_public`.

## Validation

From repo root:

- `npm ci`
- `npm run check` runs lint, type checks, complete unit/integration suite and dry bundles for the dashboard and probe; never deploys.
- `npm run test -w apps/mcp-probe` runs focused provider/MCP tests with synthetic signed Access JWTs and in-memory KV plus the actual replay guard against local workerd storage.

The deployment config has no route and uses an invalid origin and placeholder KV ID. All private identity settings are empty. It is intentionally not deployment-ready until approved configuration is supplied. Local provider tests do not prove live Access policy matching, distributed Cloudflare KV propagation, live CIMD discovery, or ChatGPT interoperability.

## Live acceptance checklist after approval

1. Confirm existing dashboard Access and alternate-origin protections are unchanged.
2. Verify unauthenticated `/mcp` returns OAuth discovery challenge; metadata/token are reachable without interactive Access; `/authorize` is owner-only at Access and Worker layers. Test wrong owner and expired Access session.
3. Connect the exact HTTPS `/mcp` URL from ChatGPT custom MCP setup. Review client callback and consent. Owner completes authentication and explicit consent; do not pass Access credentials as an API key.
4. Chad calls `get_integration_status` twice from the actual user conversation. Record version, matching opaque owner ID and different nonces. Tool list must contain no job/data commands.
5. Check expired/forged/wrong-audience tokens fail and a rejected/replayed consent cannot grant access. Ten-minute expiration requires reconnect.
6. Report precisely what passed. A setup chip, successful Inspector test or HTTP 200 alone does not satisfy step 4. If tools do not surface to Chad, report that verified client/runtime boundary instead of claiming integration.

Sources: [Cloudflare provider](https://github.com/cloudflare/workers-oauth-provider), [consent helpers](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/consent-page.md), [OpenAI OAuth requirements](https://developers.openai.com/plugins/build/auth), [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
