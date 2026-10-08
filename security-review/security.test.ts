import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import type { Env } from "../apps/worker/src/env";
const fixture = vi.hoisted(() => ({ jwks: { keys: [] as object[] } }));
vi.mock("jose", async () => {
  const real = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...real,
    createRemoteJWKSet: () => real.createLocalJWKSet(fixture.jwks),
  };
});
import {
  authenticate,
  csrfToken,
  guardMutation,
  isDemo,
} from "../apps/worker/src/auth";
import { media, parseRange } from "../apps/worker/src/media";
const env = {
  APP_ENV: "production",
  APP_ORIGIN: "https://review.example",
  ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
  ACCESS_AUD: "audience",
  OWNER_EMAIL: "owner@example.com",
  CSRF_SECRET: "a-secure-test-secret-only-12345",
} as Env;
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  fixture.jwks.keys = [
    { ...(await exportJWK(pair.publicKey)), kid: "fixture", alg: "RS256" },
  ];
});
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    email: env.OWNER_EMAIL,
    sub: "owner",
    iss: "https://fixture.cloudflareaccess.com",
    aud: "audience",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .sign(privateKey);
}
async function req(claims: Record<string, unknown> = {}) {
  return new Request("https://review.example/api/episodes", {
    headers: { "Cf-Access-Jwt-Assertion": await token(claims) },
  });
}
describe("Access verification with local RSA/JWKS fixtures (no live Access)", () => {
  it("accepts a valid owner signature", async () =>
    expect(await authenticate(await req(), env)).toBe("owner"));
  it.each([
    { email: "other@example.com" },
    { aud: "wrong" },
    { iss: "https://evil.example" },
    { exp: 1 },
  ])("rejects invalid claims %o", async (claims) => {
    await expect(authenticate(await req(claims), env)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("rejects tampered signature", async () => {
    const t = await token();
    const parts = t.split(".");
    parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    await expect(
      authenticate(
        new Request(env.APP_ORIGIN!, {
          headers: { "Cf-Access-Jwt-Assertion": parts.join(".") },
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("fails closed for missing config and alternate origins", async () => {
    await expect(
      authenticate(await req(), { ...env, ACCESS_AUD: undefined }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      authenticate(new Request("https://alternate.example"), env),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("never enables demo through request query or production local host", () => {
    expect(isDemo(new Request("https://review.example/?demo=true"), env)).toBe(
      false,
    );
    expect(
      isDemo(new Request("http://localhost/?demo=true"), {
        ...env,
        LOCAL_DEMO: "true",
      }),
    ).toBe(false);
    expect(
      isDemo(new Request("https://evil.example"), {
        ...env,
        APP_ENV: "local",
        LOCAL_DEMO: "true",
      }),
    ).toBe(false);
  });
  it("requires same origin plus CSRF token", async () => {
    const csrf = await csrfToken("owner", env, false);
    const make = (origin: string, token = csrf) =>
      new Request(env.APP_ORIGIN!, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
      });
    await expect(
      guardMutation(make(env.APP_ORIGIN!), env, "owner"),
    ).resolves.toBeUndefined();
    await expect(
      guardMutation(make("https://evil.example"), env, "owner"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      guardMutation(make(env.APP_ORIGIN!, "bad"), env, "owner"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
describe("Private Drive stream with in-memory fetch fixtures (no live Drive)", () => {
  const artifact = {
    file_id: "approved-id",
    size: 10,
    sha256: "hash",
    mime: "video/mp4",
  };
  const db = {
    prepare: () => ({ bind: () => ({ first: async () => artifact }) }),
  };
  const configured = {
    ...env,
    DB: db,
    GOOGLE_CLIENT_ID: "test",
    GOOGLE_CLIENT_SECRET: "test",
    GOOGLE_REFRESH_TOKEN: "test",
  } as unknown as Env;
  const calls: string[] = [];
  function fetcher(bad = false) {
    calls.length = 0;
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("oauth2"))
        return Response.json({ access_token: "private-test-token" });
      if (url.includes("fields="))
        return Response.json({
          size: "10",
          mimeType: "video/mp4",
          capabilities: { canDownload: true },
          sha256Checksum: "hash",
        });
      const range = new Headers(init?.headers).get("Range");
      return new Response(new Uint8Array(range ? 3 : 10), {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": bad ? "text/html" : "video/mp4",
          "Content-Length": range ? "3" : "10",
          ...(range ? { "Content-Range": "bytes 2-4/10" } : {}),
        },
      });
    }) as unknown as typeof fetch;
  }
  it.each([
    ["bytes=2-4", { start: 2, end: 4 }],
    ["bytes=8-", { start: 8, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }],
    ["bytes=0-100", { start: 0, end: 9 }],
  ])("normalizes %s", (range, result) =>
    expect(parseRange(range as string, 10)).toEqual(result),
  );
  it.each([
    "bytes=10-",
    "bytes=-0",
    "bytes=2-1",
    "bytes=1-2,4-5",
    "bytes=",
    "items=0-1",
  ])("rejects %s", (range) => expect(() => parseRange(range, 10)).toThrow());
  it("returns exact 206 with no exposed credentials", async () => {
    const response = await media(
      new Request("https://review.example/media/render/original", {
        headers: { Range: "bytes=2-4" },
      }),
      configured,
      "render",
      "original",
      fetcher(),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect((await response.arrayBuffer()).byteLength).toBe(3);
    expect(JSON.stringify([...response.headers])).not.toContain(
      "private-test-token",
    );
    expect(
      calls.every(
        (url) =>
          url.startsWith("https://oauth2.googleapis.com/") ||
          url.startsWith(
            "https://www.googleapis.com/drive/v3/files/approved-id?",
          ),
      ),
    ).toBe(true);
  });
  it("HEAD verifies metadata but fetches no media bytes", async () => {
    const response = await media(
      new Request("https://review.example/media/render/original", {
        method: "HEAD",
      }),
      configured,
      "render",
      "original",
      fetcher(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(calls).toHaveLength(2);
    expect(response.body).toBeNull();
  });
  it("416 carries known size", async () => {
    const response = await media(
      new Request("https://review.example/media/render/original", {
        headers: { Range: "bytes=10-" },
      }),
      configured,
      "render",
      "original",
      fetcher(),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
  });
  it("rejects HTML upstream and missing OAuth", async () => {
    await expect(
      media(
        new Request("https://review.example/media/render/original"),
        configured,
        "render",
        "original",
        fetcher(true),
      ),
    ).rejects.toMatchObject({ status: 502 });
    await expect(
      media(
        new Request("https://review.example/media/render/original"),
        { ...configured, GOOGLE_REFRESH_TOKEN: undefined },
        "render",
        "original",
        fetcher(),
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_UNCONFIGURED" });
  });
});

import worker from "../apps/worker/src/index";
describe("Whole-worker boundary fixtures", () => {
  it.each([
    "/",
    "/index.html",
    "/assets/app.js",
    "/api/episodes",
    "/api/catalog/status",
    "/media/approved/original",
    "/media/approved/thumbnail",
  ])("denies unauthenticated %s before touching bindings", async (path) => {
    const response = await worker.fetch(
      new Request(`https://review.example${path}`),
      env,
    );
    expect(response.status).toBe(401);
  });
  it.each([
    "/",
    "/api/episodes",
    "/api/catalog/status",
    "/media/approved/original",
    "/media/approved/thumbnail",
  ])("denies unconfigured %s", async (path) => {
    const response = await worker.fetch(
      new Request(`https://review.example${path}?demo=true`),
      { ...env, ACCESS_AUD: undefined, LOCAL_DEMO: "true" },
    );
    expect(response.status).toBe(503);
  });
  it.each([
    "/media/https%3A%2F%2Fevil.example/original",
    "/media/approved/https://evil.example",
    "/media/approved/other",
  ])("rejects arbitrary media routes %s", async (path) => {
    const response = await worker.fetch(
      new Request(`https://review.example${path}`, {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
      env,
    );
    expect(response.status).toBe(404);
  });
  it("denies a signed non-owner thumbnail request before touching bindings", async () => {
    const response = await worker.fetch(
      new Request("https://review.example/media/approved/thumbnail", {
        headers: {
          "Cf-Access-Jwt-Assertion": await token({
            email: "other@example.com",
          }),
        },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });
  it.each(["original", "thumbnail"])(
    "does not accept unregistered Drive file IDs for %s",
    async (kind) => {
      const configured = {
        ...env,
        DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
      } as unknown as Env;
      const response = await worker.fetch(
        new Request(`https://review.example/media/arbitraryDriveFile/${kind}`, {
          headers: { "Cf-Access-Jwt-Assertion": await token() },
        }),
        configured,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("MEDIA_UNAVAILABLE");
    },
  );
});

describe("new workflow endpoint access boundaries", () => {
  it.each([
    "/api/publication",
    "/api/editorial/profile",
    "/api/editorial/context?episodeId=example",
    "/api/editorial/history",
    "/api/renders/example/airing",
    "/api/airing/input?episodeId=example&renderId=example",
  ])("denies unauthenticated read %s before database access", async (path) => {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + path),
      env,
    );
    expect(response.status).toBe(401);
  });
  it.each([
    "/api/publication/sync",
    "/api/editorial/profile",
    "/api/editorial/feedback",
    "/api/editorial/receipts",
    "/api/airing/evidence",
    "/api/airing/example",
  ])("requires CSRF for owner mutation %s", async (path) => {
    const response = await worker.fetch(
      new Request(env.APP_ORIGIN + path, {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await token(),
          Origin: env.APP_ORIGIN!,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      env,
    );
    expect(response.status).toBe(403);
  });
});
