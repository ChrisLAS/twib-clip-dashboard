import {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  OAuthProvider,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { verifyOwner } from "./owner";
import { claimOnce, markerKey } from "./replay";
import { serveMcp, SCOPE } from "./mcp";
export { ReplayGuard } from "./replay";

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const error = (status: number, message: string) =>
  new Response(message, { status, headers: { "Cache-Control": "no-store" } });

function redirects(env: Env): string[] {
  return env.ALLOWED_REDIRECT_URIS.split(",").filter(Boolean);
}
function configured(env: Env): boolean {
  try {
    const url = new URL(env.PROBE_ORIGIN);
    return (
      url.protocol === "https:" &&
      url.origin === env.PROBE_ORIGIN &&
      !url.hostname.endsWith(".invalid") &&
      /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN) &&
      Boolean(env.ACCESS_AUD && env.OWNER_EMAIL) &&
      /^[a-zA-Z0-9_-]{16,128}$/.test(env.OWNER_OPAQUE_ID) &&
      redirects(env).length > 0 &&
      redirects(env).every((uri) => new URL(uri).protocol === "https:")
    );
  } catch {
    return false;
  }
}
function exactResource(params: URLSearchParams, env: Env): boolean {
  return (
    params.getAll("resource").length === 1 &&
    params.get("resource") === `${env.PROBE_ORIGIN}/mcp`
  );
}
async function authorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (!["GET", "POST"].includes(request.method))
    return error(405, "Method not allowed");
  try {
    await verifyOwner(request, env);
  } catch {
    return error(401, "Owner authentication required");
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const params = new URL(request.url).searchParams;
      if (
        [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
        !exactResource(params, env) ||
        params.getAll("code_challenge_method").length !== 1 ||
        params.get("code_challenge_method") !== "S256"
      )
        return error(400, "Exact resource and S256 PKCE required");
      const auth = await oauth.parseAuthRequest(request);
      if (
        !redirects(env).includes(auth.redirectUri) ||
        auth.scope.length !== 1 ||
        auth.scope[0] !== SCOPE
      )
        return error(400, "Unsupported redirect or scope");
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Referrer-Policy", "no-referrer");
      consent.headers.set(
        "Content-Security-Policy",
        "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>TWiB connection test</title><h1>Allow this connection test?</h1><p>Client: ${escape(details.clientName)}. ${details.clientDomain ? `Publisher: ${escape(details.clientDomain)}.` : "Client name is self-reported."}</p><p>Redirect destination: ${escape(details.redirectHost)}</p><p>Scope: ${SCOPE}. Returns only probe version, opaque owner ID and a fresh nonce. No clip, media, review or job access. Access expires after 10 minutes; no refresh token.</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(consent.handle)}"><button name="decision" value="approve">Allow connection test</button><button name="decision" value="deny">Deny</button></form>`,
        { headers: consent.headers },
      );
    }
    if (request.headers.get("Origin") !== env.PROBE_ORIGIN)
      return error(403, "Invalid origin");
    const form = await request.formData();
    const handle = form.get("handle");
    if (typeof handle !== "string" || handle.length > 512)
      return error(400, "Invalid consent");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      if (!(await claimOnce(env, "consent", handle)))
        return error(400, "Consent already decided");
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle, {
      scope: [SCOPE],
    });
    if (!(await claimOnce(env, "consent", handle)))
      return error(400, "Consent already used");
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: env.OWNER_OPAQUE_ID,
      metadata: {},
      scope: [SCOPE],
      props: { ownerId: env.OWNER_OPAQUE_ID },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (e) {
    if (e instanceof AuthorizationError || e instanceof CimdFetchError)
      return error(
        400,
        "Invalid or expired authorization request. Start again from the client.",
      );
    throw e;
  }
}
export function createProvider(env: Env, onCodeReplay: () => void = () => {}) {
  return new OAuthProvider<OAuthEnv>({
    onError: ({ internal }) => {
      if (
        internal.category === "authorization-code-grant" &&
        internal.reason === "code_replayed"
      )
        onCodeReplay();
    },
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 600,
    refreshTokenTTL: 0,
    clientRegistrationTTL: 86400,
    scopesSupported: [SCOPE],
    requiredScopes: [SCOPE],
    resourceMetadata: {
      resource: `${env.PROBE_ORIGIN}/mcp`,
      authorization_servers: [env.PROBE_ORIGIN],
    },
    tokenExchangeCallback: async (options) => {
      if (
        options.grantType !== "authorization_code" ||
        options.userId !== env.OWNER_OPAQUE_ID
      )
        throw new OAuthError("invalid_grant", {
          description: "Invalid or used grant",
        });
      const key = await markerKey(
        "grant",
        `${options.userId}:${options.grantId}`,
      );
      if (!(await options.env.REPLAY_GUARD.getByName(key).claim(key)))
        throw new OAuthError("invalid_grant", {
          description: "Invalid or used grant",
        });
      return {
        accessTokenProps: { ownerId: env.OWNER_OPAQUE_ID, replayKey: key },
      };
    },
    clientRegistrationCallback: ({ clientMetadata }) => {
      if (
        !Array.isArray(clientMetadata.redirect_uris) ||
        !clientMetadata.redirect_uris.length ||
        !clientMetadata.redirect_uris.every(
          (uri) => typeof uri === "string" && redirects(env).includes(uri),
        )
      ) {
        return {
          code: "invalid_redirect_uri",
          description: "Redirect not allowed",
          status: 400,
        };
      }
    },
    apiHandler: {
      async fetch(request, bindings, context) {
        if (new URL(request.url).pathname !== "/mcp")
          return error(404, "Not found");
        const ctx = context as ExecutionContext<{
          ownerId?: string;
          replayKey?: string;
        }> & { auth: OAuthResourceAuth };
        if (
          ctx.props.ownerId !== bindings.OWNER_OPAQUE_ID ||
          ctx.auth.audience !== `${bindings.PROBE_ORIGIN}/mcp` ||
          !ctx.auth.scope.includes(SCOPE) ||
          !ctx.props.replayKey ||
          (await bindings.REPLAY_GUARD.getByName(ctx.props.replayKey).revoked())
        )
          return error(403, "Insufficient permission");
        return serveMcp(request, bindings);
      },
    },
    defaultHandler: {
      fetch: (request, bindings) =>
        new URL(request.url).pathname === "/authorize"
          ? authorize(request, bindings)
          : Promise.resolve(error(404, "Not found")),
    },
  });
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (!configured(env)) return error(503, "Probe not configured");
    const url = new URL(request.url);
    if (url.origin !== env.PROBE_ORIGIN) return error(421, "Wrong origin");
    if (
      request.headers.has("Origin") &&
      ![env.PROBE_ORIGIN, "https://chatgpt.com"].includes(
        request.headers.get("Origin")!,
      )
    )
      return error(403, "Invalid origin");
    let exchangeCode: string | null = null;
    if (request.method === "POST") {
      // Read a bounded stream even when Content-Length is absent or dishonest.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 16_384) {
            await reader.cancel();
            return error(413, "Request too large");
          }
          chunks.push(value);
        }
      }
      request = new Request(request, {
        body: new Blob(chunks.map((chunk) => new Uint8Array(chunk))).stream(),
        duplex: "half",
      } as RequestInit);
      if (url.pathname === "/oauth/token") {
        if (
          request.headers
            .get("Content-Type")
            ?.split(";")[0]
            .trim()
            .toLowerCase() !== "application/x-www-form-urlencoded"
        )
          return error(415, "Form encoding required");
        const params = new URLSearchParams(await request.clone().text());
        exchangeCode = params.get("code");
        if (
          [...params.keys()].some((key) => params.getAll(key).length !== 1) ||
          !(
            (params.get("grant_type") === "authorization_code" &&
              exactResource(params, env)) ||
            (!params.has("grant_type") &&
              Boolean(params.get("token")) &&
              !params.has("code"))
          )
        )
          return error(400, "Authorization code and exact resource required");
      }
    }
    let codeReplay = false;
    const response = await createProvider(env, () => {
      codeReplay = true;
    }).fetch(request, env as OAuthEnv, ctx);
    if (codeReplay && exchangeCode) {
      // This branch is reached only after the provider verifies the code hash and client.
      const [userId, grantId] = exchangeCode.split(":");
      await claimOnce(env, "grant", `${userId}:${grantId}`);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
};
