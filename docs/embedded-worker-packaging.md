# Preserve an embedded frontend during a receiver-only deployment

Some existing deployments package static frontend files inside the Worker module
and inject a small `ASSETS` adapter. Cloudflare reports no native Assets storage or
ASSETS binding for those versions. `keep_assets: true` cannot preserve bytes that
are part of an old JavaScript module. Uploading only the backend bundle would lose
the frontend even while every platform binding is retained.

## Build reproducibly, without deploying

Use `scripts/build-embedded-worker.mjs` with a reviewed receiver bundle and an
asset JSON object whose keys are exact URL paths and values exactly
`{"body":"file text","type":"original content type"}`. Include `/index.html`.
For a preserve-only update, recover the approved prior version's assets rather
than rebuilding a different frontend. Decode static literal data with a parser;
never eval an entire downloaded Worker just to extract an asset map.

After the normal `npm run check` dry-run build:

```sh
node scripts/build-embedded-worker.mjs \
  apps/worker/dist/worker/index.js \
  /private/reviewed-assets.json \
  /private/deploy-output
```

The command performs no network or deployment. It produces:

- `receiver.mjs`: byte-for-byte copy of the reviewed backend bundle
- `worker.mjs`: wrapper and embedded static asset map; main module for upload
- `asset-hashes.json`: path, content type, byte count and SHA-256 for every asset

Keep recovered production modules/maps, private configuration and deployment
receipts outside the public repository. Compare all asset hash records to the
prior version and compare `receiver.mjs` to the exact reviewed build. The private
receipt should record source commit, prior/new version IDs, bundle hash and asset
hash equality separately; never record secret values.

## Exact routing and security boundary

The adapter preserves the legacy routing: GET/HEAD only; percent/backslash paths,
API/media paths and missing static assets do not receive a frontend fallback.
Root and extensionless non-assets/non-demo paths use `/index.html`. HEAD has no
body and preserves content type. These rules do not create a new unauthenticated
route: the wrapper delegates to the receiver's existing fetch handler with an
injected ASSETS binding, and owner authentication runs before frontend serving.
Receiver security/cache headers and error responses remain authoritative. The
scheduled handler and other exports are retained. Machine ingress remains
independently disabled unless its private configuration is explicitly activated.

`apps/worker/test/embedded-assets.test.ts` covers routing, missing files, HEAD,
content types, auth isolation, cache/security headers, disabled ingestion,
byte-preserving packaging and scheduled export delegation.

## Separately approved deployment

Upload **both** `worker.mjs` and `receiver.mjs` as ES module parts with
`main_module="worker.mjs"`. Also preserve all existing platform binding types,
secrets without retrieving values, native assets with explicit `keep_assets`,
compatibility settings, CPU ceiling, domain and schedules. Do not use placeholder
repository database IDs or apply all migrations to an untracked live schema.

Validate the actual deployed module bytes/hash, active version, retained bindings,
crons and owner Access policy. Preserve the prior version for immediate rollback.
A source build pass does not prove the deployment package includes the frontend.
If edge security blocks an external probe, do not bypass it; report the HTTP
verification limit and use permitted metadata plus local exact-artifact tests.
Never claim authenticated live-page validation based only on a blocked probe.
