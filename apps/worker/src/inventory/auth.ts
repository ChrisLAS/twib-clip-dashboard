import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { Env } from "../env";
import { HttpError } from "../errors";
import { inventoryEpisodeId, type InventoryGrant } from "./contract";

export const INVENTORY_INGEST_PATH = "/api/v2/number-one/inventory-snapshots";
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const disabled = () =>
  new HttpError(
    503,
    "INVENTORY_INGESTION_DISABLED",
    "Inventory ingestion is not activated.",
  );
export const INVENTORY_AUTH_CATEGORIES = [
  "assertion_missing",
  "assertion_shape",
  "request_scope",
  "jwks_unavailable",
  "signature",
  "issuer",
  "audience",
  "expiry",
  "service_identity",
  "issued_at",
  "token_lifetime",
] as const;
export class InventoryAuthError extends HttpError {
  constructor(
    public readonly category: (typeof INVENTORY_AUTH_CATEGORIES)[number],
  ) {
    super(
      401,
      "INVENTORY_AUTH_REQUIRED",
      "A valid inventory machine identity is required.",
    );
  }
}
const denied = (category: (typeof INVENTORY_AUTH_CATEGORIES)[number]) =>
  new InventoryAuthError(category);
const scopeDenied = () =>
  new HttpError(
    403,
    "INVENTORY_SCOPE_DENIED",
    "A current source-and-episode inventory grant is required.",
  );

// No client secret is stored or compared here. Access authenticates the one
// service credential; this adapter verifies its signed, dedicated-app assertion.
export async function authenticateInventory(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<InventoryGrant> {
  const origin = env.INVENTORY_APP_ORIGIN;
  const team = env.INVENTORY_ACCESS_TEAM_DOMAIN;
  const audience = env.INVENTORY_ACCESS_AUD;
  const client = env.INVENTORY_ACCESS_CLIENT_ID;
  const starts = Date.parse(env.INVENTORY_GRANT_STARTS_AT ?? "");
  const expires = Date.parse(env.INVENTORY_GRANT_EXPIRES_AT ?? "");
  let originUrl: URL;
  try {
    originUrl = new URL(origin ?? "");
  } catch {
    throw disabled();
  }
  if (
    env.INVENTORY_INGEST_ENABLED !== "true" ||
    originUrl.protocol !== "https:" ||
    originUrl.origin !== origin ||
    originUrl.username ||
    originUrl.password ||
    originUrl.port ||
    !team ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) ||
    !audience ||
    !/^[a-f0-9]{64}$/.test(audience) ||
    !env.ACCESS_AUD ||
    audience === env.ACCESS_AUD ||
    !client ||
    !/^[a-zA-Z0-9_-]+\.access$/.test(client) ||
    client.length > 128 ||
    !Number.isFinite(starts) ||
    !Number.isFinite(expires) ||
    expires <= starts ||
    expires - starts > 86400000
  )
    throw disabled();
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    url.pathname !== INVENTORY_INGEST_PATH ||
    url.search ||
    url.hash ||
    request.method !== "POST"
  )
    throw denied("request_scope");
  if (now < starts || now >= expires) throw scopeDenied();
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw denied("assertion_missing");
  if (token.length > 16384) throw denied("assertion_shape");
  const issuer = `https://${team}`;
  try {
    let jwks = keys.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5000,
      });
      keys.set(issuer, jwks);
    }
    const resolveKey: ReturnType<typeof createRemoteJWKSet> = jwks;
    const { payload } = await jwtVerify(
      token,
      async (header, flattened) => {
        try {
          return await resolveKey(header, flattened);
        } catch {
          // Never expose a fetch error, response, key, header or token payload.
          throw denied("jwks_unavailable");
        }
      },
      {
        issuer,
        audience,
        algorithms: ["RS256"],
        currentDate: new Date(now),
        requiredClaims: [
          "iss",
          "aud",
          "exp",
          "iat",
          "type",
          "common_name",
          "sub",
        ],
      },
    );
    const seconds = Math.floor(now / 1000);
    if (
      payload.type !== "app" ||
      payload.common_name !== client ||
      payload.sub !== "" ||
      payload.email !== undefined
    )
      throw denied("service_identity");
    if (
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp)
    )
      throw denied("assertion_shape");
    if (payload.iat! > seconds + 60 || seconds - payload.iat! > 900)
      throw denied("issued_at");
    if (payload.exp! <= payload.iat! || payload.exp! - payload.iat! > 3600)
      throw denied("token_lifetime");
    if (
      !Array.isArray(payload.aud) ||
      payload.aud.length !== 1 ||
      payload.aud[0] !== audience
    )
      throw denied("audience");
  } catch (error) {
    if (error instanceof InventoryAuthError) throw error;
    if (error instanceof errors.JWTExpired) throw denied("expiry");
    if (error instanceof errors.JWTClaimValidationFailed) {
      // Only compare the library's fixed claim name. Its payload/message may
      // contain sensitive values and must never be returned or logged.
      if (error.claim === "iss") throw denied("issuer");
      if (error.claim === "aud") throw denied("audience");
      if (error.claim === "exp" || error.claim === "nbf")
        throw denied("expiry");
      throw denied("assertion_shape");
    }
    if (error instanceof errors.JWSSignatureVerificationFailed)
      throw denied("signature");
    throw denied("assertion_shape");
  }
  return {
    sourceId: "nomad:number-one",
    episodeNumber: 127,
    episodeId: await inventoryEpisodeId(127),
    scope: "inventory:write",
    expiresAt: expires,
    allowEditorialContext: false,
    originHosts: [],
  };
}
