import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
import worker from "../src/index";

const ORIGIN = "https://probe.example.com";
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const RESOURCE = `${ORIGIN}/mcp`;
let env: Env;
let ownerJwt: string;
let wrongOwnerJwt: string;
const pending: Promise<unknown>[] = [];
function context() {
  return {
    props: {},
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}
class MemoryKV {
  values = new Map<string, { value: string; expiration?: number }>();
  async get(key: string, options?: { type?: string }) {
    const entry = this.values.get(key);
    if (!entry || (entry.expiration && entry.expiration <= Date.now() / 1000))
      return null;
    return options?.type === "json" ? JSON.parse(entry.value) : entry.value;
  }
  async put(
    key: string,
    value: string,
    options?: { expiration?: number; expirationTtl?: number },
  ) {
    this.values.set(key, {
      value,
      expiration:
        options?.expiration ??
        (options?.expirationTtl
          ? Date.now() / 1000 + options.expirationTtl
          : undefined),
    });
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list(options: { prefix?: string }) {
    return {
      keys: [...this.values.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
}
beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      expect(String(url)).toBe(
        "https://test.cloudflareaccess.com/cdn-cgi/access/certs",
      );
      return Response.json({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
    }),
  );
  async function jwt(email: string) {
    return new SignJWT({ email })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setSubject("test-subject")
      .setIssuer("https://test.cloudflareaccess.com")
      .setAudience("test-audience")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(keys.privateKey);
  }
  ownerJwt = await jwt("owner@example.com");
  wrongOwnerJwt = await jwt("other@example.com");
});
beforeEach(() => {
  const claimed = new Set<string>();
  const revoked = new Set<string>();
  env = {
    PROBE_ORIGIN: ORIGIN,
    APP_VERSION: "mcp-probe-test",
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
    OWNER_EMAIL: "owner@example.com",
    OWNER_OPAQUE_ID: "opaque-test-owner-123",
    ALLOWED_REDIRECT_URIS: CALLBACK,
    OAUTH_KV: new MemoryKV(),
    REPLAY_GUARD: {
      getByName: (id: string) => ({
        async revoked() {
          return revoked.has(id);
        },
        async claim(key: string) {
          if (claimed.has(key)) {
            revoked.add(key);
            return false;
          }
          claimed.add(key);
          return true;
        },
      }),
    },
  } as unknown as Env;
});
async function req(path: string, init?: RequestInit) {
  return worker.fetch(new Request(new URL(path, ORIGIN), init), env, context());
}
async function start(changes: Record<string, string> = {}, jwt = ownerJwt) {
  const registration = await req("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test client",
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = (await registration.json()) as { client_id: string };
  const verifier = "a".repeat(64);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Buffer.from(digest).toString("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: CALLBACK,
    response_type: "code",
    scope: "integration:status",
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...changes,
  });
  const response = await req(`/authorize?${params}`, {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });
  return { response, verifier, clientId: client.client_id };
}
async function approve() {
  const started = await start();
  expect(started.response.status).toBe(200);
  const html = await started.response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  const cookie = started.response.headers.get("Set-Cookie")!.split(";")[0];
  const init = {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": ownerJwt,
      Origin: ORIGIN,
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision: "approve" }),
  };
  const response = await req("/authorize", init);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  expect(location.searchParams.get("iss")).toBe(ORIGIN);
  return {
    ...started,
    code: location.searchParams.get("code")!,
    consentInit: init,
  };
}
async function exchange(
  auth: Awaited<ReturnType<typeof approve>>,
  changes: Record<string, string> = {},
) {
  return req("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: auth.clientId,
      code: auth.code,
      code_verifier: auth.verifier,
      redirect_uri: CALLBACK,
      resource: RESOURCE,
      ...changes,
    }),
  });
}
async function rpc(token: string, method: string, params: object = {}) {
  return req("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
function kv() {
  return env.OAUTH_KV as unknown as MemoryKV;
}
async function consentForm(decision: string) {
  const started = await start();
  const html = await started.response.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
  return {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": ownerJwt,
      Origin: ORIGIN,
      Cookie: started.response.headers.get("Set-Cookie")!.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ handle, decision }),
  };
}
describe("isolated authenticated connection probe", () => {
  it("rejects missing and wrong consent browser cookies", async () => {
    const form = await consentForm("approve");
    for (const Cookie of ["", "__Host-oauth-consent-wrong=wrong"]) {
      expect(
        (
          await req("/authorize", {
            ...form,
            headers: { ...form.headers, Cookie },
          })
        ).status,
      ).toBe(400);
    }
  });
  it("denial wins even if consent KV is stale", async () => {
    const form = await consentForm("deny");
    const stale = new Map(kv().values);
    expect((await req("/authorize", form)).status).toBe(302);
    kv().values = stale;
    form.body.set("decision", "approve");
    expect((await req("/authorize", form)).status).toBe(400);
  });
  it("revokes on validated sequential replay even with stale token reads", async () => {
    const auth = await approve();
    const token = (await (await exchange(auth)).json()) as {
      access_token: string;
    };
    const stale = new Map(kv().values);
    expect((await exchange(auth)).status).toBe(400);
    kv().values = stale;
    expect((await rpc(token.access_token, "tools/list")).status).toBe(403);
  });
  it("denies stale-KV second issuance and invalidates first token", async () => {
    const auth = await approve();
    const stale = new Map(kv().values);
    const token = (await (await exchange(auth)).json()) as {
      access_token: string;
    };
    const issued = new Map(kv().values);
    kv().values = stale;
    expect((await exchange(auth)).status).toBe(400);
    kv().values = issued;
    expect((await rpc(token.access_token, "tools/list")).status).toBe(403);
  });
  it("supports advertised RFC 7009 disconnect revocation", async () => {
    const auth = await approve();
    const token = (await (await exchange(auth)).json()) as {
      access_token: string;
    };
    const revoke = await req("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: token.access_token,
        client_id: auth.clientId,
      }),
    });
    expect(revoke.status).toBe(200);
    expect((await rpc(token.access_token, "tools/list")).status).toBe(401);
  });

  it("fails closed before configuration and on alternate hosts", async () => {
    expect(
      (
        await worker.fetch(
          new Request("https://other.example/mcp"),
          env,
          context(),
        )
      ).status,
    ).toBe(421);
    env.OWNER_EMAIL = "";
    expect((await req("/mcp")).status).toBe(503);
  });
  it("advertises discovery and denies unauthenticated or forged tokens", async () => {
    const response = await req("/mcp");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata",
    );
    const metadata = (await (
      await req("/.well-known/oauth-authorization-server")
    ).json()) as Record<string, unknown>;
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    expect((await rpc("forged", "tools/list")).status).toBe(401);
  });
  it("rejects wrong owner and no owner", async () => {
    expect((await start({}, wrongOwnerJwt)).response.status).toBe(401);
    expect((await start({}, "")).response.status).toBe(401);
  });
  it.each<Record<string, string>>([
    { code_challenge_method: "plain" },
    { resource: "https://other.example/mcp" },
    { resource: "" },
    { redirect_uri: "https://evil.example/callback" },
    { scope: "clips:write" },
  ])("rejects invalid authorization %j", async (changes) => {
    expect((await start(changes)).response.status).toBe(400);
  });
  it("requires browser consent and rejects consent replay", async () => {
    const auth = await approve();
    expect((await req("/authorize", auth.consentInit)).status).toBe(400);
    expect(
      (
        await req("/authorize", {
          ...auth.consentInit,
          headers: {
            ...auth.consentInit.headers,
            Origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
  });
  it("rejects wrong PKCE without burning code, wrong resource, and changed redirect", async () => {
    const auth = await approve();
    for (const changes of [
      { code_verifier: "b".repeat(64) },
      { resource: "https://other.example/mcp" },
      { redirect_uri: "https://evil.example/callback" },
    ] as Record<string, string>[])
      expect((await exchange(auth, changes)).status).toBe(400);
    expect((await exchange(auth)).status).toBe(200);
  });
  it("exchanges once; no refresh; one readonly tool returns fresh nonce and opaque identity", async () => {
    const auth = await approve();
    const response = await exchange(auth);
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.expires_in).toBe(600);
    const tools = (await (
      await rpc(tokens.access_token, "tools/list")
    ).json()) as {
      result: {
        tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
      };
    };
    expect(tools.result.tools.map((t) => t.name)).toEqual([
      "get_integration_status",
    ]);
    expect(tools.result.tools[0].annotations.readOnlyHint).toBe(true);
    const call = async () =>
      (await (
        await rpc(tokens.access_token, "tools/call", {
          name: "get_integration_status",
          arguments: {},
        })
      ).json()) as { result: { structuredContent: Record<string, string> } };
    const a = await call(),
      b = await call();
    expect(a.result.structuredContent).toEqual({
      app_version: env.APP_VERSION,
      owner_id: env.OWNER_OPAQUE_ID,
      nonce: expect.any(String),
    });
    expect(a.result.structuredContent.nonce).not.toBe(
      b.result.structuredContent.nonce,
    );
    expect(JSON.stringify(a)).not.toContain(env.OWNER_EMAIL);
    const unknown = (await (
      await rpc(tokens.access_token, "tools/call", {
        name: "start_job",
        arguments: {},
      })
    ).json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(Boolean(unknown.error || unknown.result?.isError)).toBe(true);
    expect((await exchange(auth)).status).toBe(400);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
  });
  it("bounds requests and rejects cross-origin requests", async () => {
    expect(
      (await req("/mcp", { method: "POST", body: "x".repeat(16385) })).status,
    ).toBe(413);
    expect(
      (await req("/mcp", { headers: { Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
  });
});
