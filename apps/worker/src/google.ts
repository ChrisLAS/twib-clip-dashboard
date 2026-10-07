import type { Env } from "./env";
import { HttpError } from "./errors";
export function googleConfigured(env: Env): boolean {
  return !!(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_REFRESH_TOKEN
  );
}
// Never inherit tool/connector credentials. No access token is persisted or sent to the browser.
export async function googleToken(
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!googleConfigured(env))
    throw new HttpError(
      503,
      "GOOGLE_UNCONFIGURED",
      "Private Drive authorization has not been connected.",
    );
  const r = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok)
    throw new HttpError(
      503,
      "GOOGLE_REAUTH_REQUIRED",
      "Private Drive access expired or was revoked. Reauthorize the approved integration.",
    );
  const body = (await r.json()) as { access_token?: string };
  if (!body.access_token)
    throw new HttpError(
      502,
      "GOOGLE_INVALID_RESPONSE",
      "Drive authorization returned an invalid response.",
    );
  return body.access_token;
}
export function upstreamError(status: number): HttpError {
  if (status === 401)
    return new HttpError(
      503,
      "GOOGLE_REAUTH_REQUIRED",
      "Drive authorization expired. Reconnect the approved integration.",
    );
  if (status === 404)
    return new HttpError(
      404,
      "MEDIA_MISSING",
      "This approved Drive artifact is unavailable.",
    );
  if (status === 403)
    return new HttpError(
      403,
      "DRIVE_FORBIDDEN",
      "Drive denied access, download permission, or quota.",
    );
  if (status === 429)
    return new HttpError(
      429,
      "DRIVE_RATE_LIMIT",
      "Drive is rate limiting requests. Try again later.",
    );
  return new HttpError(
    502,
    "DRIVE_UNAVAILABLE",
    "Drive could not serve this artifact.",
  );
}
