import { jobGrantMaxMilliseconds } from "./scope";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { Env } from "../env";
import { HttpError } from "../errors";

export const CAPTURE_JOB_PATH = "/api/v1/capture-jobs/";
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const disabled = () =>
  new HttpError(
    503,
    "CAPTURE_JOBS_INGESTION_DISABLED",
    "Capture jobs is not activated.",
  );
export const CAPTURE_JOBS_AUTH_CATEGORIES = [
  "assertion_missing",
  "assertion_shape",
  "request_scope",
  "jwks_unavailable",
  "signature",
  "issuer",
  "audience_value",
  "audience_shape",
  "expiry",
  "service_identity",
  "issued_at",
  "token_lifetime",
] as const;
export class CaptureJobAuthError extends HttpError {
  constructor(
    public readonly category: (typeof CAPTURE_JOBS_AUTH_CATEGORIES)[number],
  ) {
    super(
      401,
      "CAPTURE_JOBS_AUTH_REQUIRED",
      "A valid capture-job machine identity is required.",
    );
  }
}
const denied = (category: (typeof CAPTURE_JOBS_AUTH_CATEGORIES)[number]) =>
  new CaptureJobAuthError(category);
// RFC 7519 permits a single audience as either a string or singleton array.
// Never accept multiple audience identities, even when one matches.
function singleAudience(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    Array.isArray(value) &&
    value.length === 1 &&
    typeof value[0] === "string"
  )
    return value[0];
  return undefined;
}
const scopeDenied = () =>
  new HttpError(
    403,
    "CAPTURE_JOBS_SCOPE_DENIED",
    "A current exact-episode TWiB capture-job grant is required.",
  );

// Identity may be explicitly reused, but authority never is: a separate signed
// job audience and bounded action/source/episode grant are required on these routes.
export async function authenticateCaptureJobs(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<void> {
  const origin = env.CAPTURE_JOBS_APP_ORIGIN;
  const team = env.CAPTURE_JOBS_ACCESS_TEAM_DOMAIN;
  const audience = env.CAPTURE_JOBS_ACCESS_AUD;
  const client = env.CAPTURE_JOBS_ACCESS_CLIENT_ID;
  const reuse = env.CAPTURE_JOBS_REUSE_INVENTORY_IDENTITY;
  const sharedClient = client === env.INVENTORY_ACCESS_CLIENT_ID;
  const scopes = env.CAPTURE_JOBS_GRANT_SCOPES?.split(",") ?? [];
  const starts = Date.parse(env.CAPTURE_JOBS_GRANT_STARTS_AT ?? "");
  const expires = Date.parse(env.CAPTURE_JOBS_GRANT_EXPIRES_AT ?? "");
  let originUrl: URL;
  try {
    originUrl = new URL(origin ?? "");
  } catch {
    throw disabled();
  }
  if (
    env.CAPTURE_JOBS_ENABLED !== "true" ||
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
    audience === env.INVENTORY_ACCESS_AUD ||
    (reuse !== undefined && reuse !== "false" && reuse !== "true") ||
    (sharedClient && reuse !== "true") ||
    (reuse === "true" &&
      (!sharedClient ||
        team !== env.INVENTORY_ACCESS_TEAM_DOMAIN ||
        !/^[a-f0-9]{64}$/.test(env.INVENTORY_ACCESS_AUD ?? ""))) ||
    env.CAPTURE_JOBS_GRANT_SOURCE_ID !== "nomad:capture-worker" ||
    env.CAPTURE_JOBS_GRANT_SHOW !== "twib" ||
    !/^[1-9][0-9]{0,5}$/.test(env.CAPTURE_JOBS_GRANT_EPISODE ?? "") ||
    scopes.length < 1 ||
    scopes.length > 2 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !["job:claim", "job:result"].includes(scope)) ||
    !client ||
    !/^[a-zA-Z0-9_-]+\.access$/.test(client) ||
    client.length > 128 ||
    !Number.isFinite(starts) ||
    !Number.isFinite(expires) ||
    expires <= starts ||
    expires - starts > jobGrantMaxMilliseconds(env)
  )
    throw disabled();
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    !["/api/v1/capture-jobs/claim", "/api/v1/capture-jobs/result"].includes(
      url.pathname,
    ) ||
    url.search ||
    url.hash ||
    request.method !== "POST"
  )
    throw denied("request_scope");
  if (now < starts || now >= expires) throw scopeDenied();
  const operation = url.pathname.endsWith("/claim")
    ? "job:claim"
    : "job:result";
  if (!scopes.includes(operation)) throw scopeDenied();
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
    const tokenAudience = singleAudience(payload.aud);
    if (tokenAudience === undefined) throw denied("audience_shape");
    if (tokenAudience !== audience) throw denied("audience_value");
  } catch (error) {
    if (error instanceof CaptureJobAuthError) throw error;
    if (error instanceof errors.JWTExpired) throw denied("expiry");
    if (error instanceof errors.JWTClaimValidationFailed) {
      // Only compare the library's fixed claim name. Its payload/message may
      // contain sensitive values and must never be returned or logged.
      if (error.claim === "iss") throw denied("issuer");
      if (error.claim === "aud")
        throw denied(
          singleAudience(error.payload.aud) === undefined
            ? "audience_shape"
            : "audience_value",
        );
      if (error.claim === "exp" || error.claim === "nbf")
        throw denied("expiry");
      throw denied("assertion_shape");
    }
    if (error instanceof errors.JWSSignatureVerificationFailed)
      throw denied("signature");
    throw denied("assertion_shape");
  }
}
