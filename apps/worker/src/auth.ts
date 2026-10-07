import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./errors";
export function isDemo(request: Request, env: Env): boolean {
  return (
    env.APP_ENV === "local" &&
    env.LOCAL_DEMO === "true" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  );
}
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(
  request: Request,
  env: Env,
): Promise<string> {
  if (isDemo(request, env)) return "local-demo";
  if (
    !env.APP_ORIGIN ||
    new URL(request.url).origin !== env.APP_ORIGIN ||
    !env.ACCESS_TEAM_DOMAIN ||
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) ||
    !env.ACCESS_AUD ||
    !env.OWNER_EMAIL
  )
    throw new HttpError(
      503,
      "ACCESS_UNCONFIGURED",
      "Owner access is not configured.",
    );
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token)
    throw new HttpError(
      401,
      "AUTH_REQUIRED",
      "Sign in with the owner account.",
    );
  try {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    let jwks = keys.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keys.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "email"],
    });
    if (
      typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()
    )
      throw new Error("owner");
    return payload.sub!;
  } catch {
    throw new HttpError(
      401,
      "AUTH_REQUIRED",
      "Owner session is invalid or expired. Sign in again.",
    );
  }
}
export async function csrfToken(
  owner: string,
  env: Env,
  demo: boolean,
): Promise<string> {
  const secret = demo ? "local-demo-only-non-production" : env.CSRF_SECRET;
  if (!secret || secret.length < 24)
    throw new HttpError(
      503,
      "ACCESS_UNCONFIGURED",
      "CSRF protection is not configured.",
    );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(owner),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function guardMutation(
  request: Request,
  env: Env,
  owner: string,
): Promise<void> {
  const demo = isDemo(request, env);
  const origin = request.headers.get("Origin");
  const allowed = demo
    ? [env.APP_ORIGIN, new URL(request.url).origin, "http://127.0.0.1:5173"]
    : [env.APP_ORIGIN];
  if (
    !origin ||
    !allowed.includes(origin) ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new HttpError(
      403,
      "ORIGIN_DENIED",
      "Refresh this app before saving.",
    );
  if (
    request.headers.get("X-CSRF-Token") !== (await csrfToken(owner, env, demo))
  )
    throw new HttpError(
      403,
      "CSRF_INVALID",
      "Refresh your session before saving.",
    );
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HttpError(415, "JSON_REQUIRED", "Use JSON requests.");
}
