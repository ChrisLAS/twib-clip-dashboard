import { beforeAll, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { authenticateCaptureJobs } from "../src/capture-jobs/auth";
import { authenticateInventory } from "../src/inventory/auth";
import { authenticate } from "../src/auth";
import type { Env } from "../src/env";
const state = vi.hoisted(() => ({ key: undefined as CryptoKey | undefined }));
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return { ...actual, createRemoteJWKSet: vi.fn(() => async () => state.key) };
});
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  state.key = pair.publicKey;
});
const now = Date.parse("2026-10-13T12:00:00Z"),
  seconds = now / 1000;
const env = {
  APP_ENV: "production",
  ACCESS_AUD: "a".repeat(64),
  INVENTORY_ACCESS_AUD: "b".repeat(64),
  INVENTORY_ACCESS_CLIENT_ID: "inventory.access",
  INVENTORY_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
  CAPTURE_JOBS_ENABLED: "true",
  CAPTURE_JOBS_APP_ORIGIN: "https://jobs.example.com",
  CAPTURE_JOBS_ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
  CAPTURE_JOBS_ACCESS_AUD: "c".repeat(64),
  CAPTURE_JOBS_ACCESS_CLIENT_ID: "jobs.access",
  CAPTURE_JOBS_GRANT_SOURCE_ID: "nomad:capture-worker",
  CAPTURE_JOBS_GRANT_SHOW: "twib",
  CAPTURE_JOBS_GRANT_EPISODE: "127",
  CAPTURE_JOBS_GRANT_SCOPES: "job:claim,job:result",
  CAPTURE_JOBS_GRANT_STARTS_AT: new Date(now - 1000).toISOString(),
  CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 3600000).toISOString(),
} as Env;
async function request(
  overrides: JWTPayload = {},
  path = "/api/v1/capture-jobs/claim",
) {
  const token = await new SignJWT({
    iss: "https://synthetic.cloudflareaccess.com",
    aud: "c".repeat(64),
    sub: "",
    iat: seconds,
    exp: seconds + 600,
    type: "app",
    common_name: "jobs.access",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
  return new Request("https://jobs.example.com" + path, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}
it("accepts only separately pinned job machine identity", async () => {
  await expect(
    authenticateCaptureJobs(await request(), env, now),
  ).resolves.toBeUndefined();
  for (const claims of [
    { aud: "b".repeat(64), common_name: "inventory.access" },
    { aud: "a".repeat(64), email: "owner@example.com" },
    { common_name: "other.access" },
    { aud: ["c".repeat(64), "b".repeat(64)] },
    { iat: seconds - 1000 },
    { exp: seconds + 4000 },
  ])
    await expect(
      authenticateCaptureJobs(await request(claims), env, now),
    ).rejects.toMatchObject({ status: 401 });
});
it("grant closed on expiry, unknown route and shared inventory grant", async () => {
  await expect(
    authenticateCaptureJobs(await request(), env, now + 3600000),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    authenticateCaptureJobs(
      await request({}, "/api/v1/capture-jobs/other"),
      env,
      now,
    ),
  ).rejects.toMatchObject({ status: 401 });
  await expect(
    authenticateCaptureJobs(
      await request(),
      { ...env, CAPTURE_JOBS_ACCESS_AUD: env.INVENTORY_ACCESS_AUD },
      now,
    ),
  ).rejects.toMatchObject({ status: 503 });
  await expect(
    authenticateCaptureJobs(
      await request(),
      { ...env, CAPTURE_JOBS_ACCESS_CLIENT_ID: env.INVENTORY_ACCESS_CLIENT_ID },
      now,
    ),
  ).rejects.toMatchObject({ status: 503 });
});

const reused = {
  ...env,
  CAPTURE_JOBS_ACCESS_CLIENT_ID: env.INVENTORY_ACCESS_CLIENT_ID,
  CAPTURE_JOBS_REUSE_INVENTORY_IDENTITY: "true",
} as Env;
const reusedClaims = { common_name: "inventory.access" };

it("explicit reused identity authorizes each job action only with a job assertion", async () => {
  for (const action of ["claim", "result"]) {
    const path = "/api/v1/capture-jobs/" + action;
    await expect(
      authenticateCaptureJobs(await request(reusedClaims, path), reused, now),
    ).resolves.toBeUndefined();
    for (const claims of [
      {
        ...reusedClaims,
        aud: env.INVENTORY_ACCESS_AUD,
        scope: "inventory:write",
      },
      { ...reusedClaims, aud: env.ACCESS_AUD, email: "owner@example.com" },
      {
        ...reusedClaims,
        aud: [env.CAPTURE_JOBS_ACCESS_AUD!, env.INVENTORY_ACCESS_AUD!],
      },
      { ...reusedClaims, email: "owner@example.com" },
      { common_name: "mcp.access" },
      { type: "oauth", common_name: "drive.access" },
    ])
      await expect(
        authenticateCaptureJobs(await request(claims, path), reused, now),
      ).rejects.toMatchObject({ status: 401 });
  }
});

it("job JWT cannot ingest inventory even when both grants use the same identity", async () => {
  const inventory = {
    ...reused,
    INVENTORY_INGEST_ENABLED: "true",
    INVENTORY_APP_ORIGIN: "https://jobs.example.com",
    INVENTORY_GRANT_EPISODE_NUMBER: "127",
    INVENTORY_GRANT_STARTS_AT: env.CAPTURE_JOBS_GRANT_STARTS_AT,
    INVENTORY_GRANT_EXPIRES_AT: env.CAPTURE_JOBS_GRANT_EXPIRES_AT,
  } as Env;
  const path = "/api/v2/number-one/inventory-snapshots";
  await expect(
    authenticateInventory(
      await request({ ...reusedClaims, aud: env.INVENTORY_ACCESS_AUD }, path),
      inventory,
      now,
    ),
  ).resolves.toMatchObject({
    sourceId: "nomad:number-one",
    episodeNumber: 127,
    scope: "inventory:write",
  });
  await expect(
    authenticateInventory(await request(reusedClaims, path), inventory, now),
  ).rejects.toMatchObject({ status: 401 });
});

it("a reused job service assertion cannot authenticate as the owner", async () => {
  const owner = {
    ...reused,
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    APP_ORIGIN: "https://jobs.example.com",
    OWNER_EMAIL: "owner@example.com",
  } as Env;
  for (const claims of [reusedClaims, { ...reusedClaims, aud: env.ACCESS_AUD }])
    await expect(
      authenticate(await request(claims, "/api/capture-jobs"), owner),
    ).rejects.toMatchObject({ status: 401 });
});

it("reuse, source, episode and action grants fail closed when absent or invalid", async () => {
  for (const change of [
    { CAPTURE_JOBS_ENABLED: undefined },
    { CAPTURE_JOBS_REUSE_INVENTORY_IDENTITY: undefined },
    { CAPTURE_JOBS_REUSE_INVENTORY_IDENTITY: "false" },
    { CAPTURE_JOBS_REUSE_INVENTORY_IDENTITY: "yes" },
    { CAPTURE_JOBS_ACCESS_CLIENT_ID: undefined },
    { CAPTURE_JOBS_ACCESS_AUD: undefined },
    { CAPTURE_JOBS_ACCESS_AUD: env.INVENTORY_ACCESS_AUD },
    { CAPTURE_JOBS_ACCESS_AUD: env.ACCESS_AUD },
    { INVENTORY_ACCESS_AUD: undefined },
    { INVENTORY_ACCESS_TEAM_DOMAIN: "other.cloudflareaccess.com" },
    { CAPTURE_JOBS_GRANT_SOURCE_ID: undefined },
    { CAPTURE_JOBS_GRANT_SOURCE_ID: "nomad:number-one" },
    { CAPTURE_JOBS_GRANT_SHOW: "launch" },
    { CAPTURE_JOBS_GRANT_SHOW: undefined },
    { CAPTURE_JOBS_GRANT_EPISODE: "0" },
    { CAPTURE_JOBS_GRANT_EPISODE: undefined },
    { CAPTURE_JOBS_GRANT_SCOPES: undefined },
    { CAPTURE_JOBS_GRANT_SCOPES: "inventory:write" },
    { CAPTURE_JOBS_GRANT_SCOPES: "job:claim,job:result,drive:read" },
    { CAPTURE_JOBS_GRANT_SCOPES: "job:claim,job:claim" },
    { CAPTURE_JOBS_GRANT_EXPIRES_AT: undefined },
    { CAPTURE_JOBS_GRANT_STARTS_AT: undefined },
    { CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 604800001).toISOString() },
  ])
    await expect(
      authenticateCaptureJobs(
        await request(reusedClaims),
        { ...reused, ...change },
        now,
      ),
    ).rejects.toMatchObject({ status: 503 });
  for (const instant of [now - 2000, now + 3600000])
    await expect(
      authenticateCaptureJobs(await request(reusedClaims), reused, instant),
    ).rejects.toMatchObject({ status: 403 });
});

it("a one-action grant cannot authorize the other operation", async () => {
  for (const action of ["claim", "result"]) {
    const oneAction = { ...reused, CAPTURE_JOBS_GRANT_SCOPES: "job:" + action };
    await expect(
      authenticateCaptureJobs(
        await request(reusedClaims, "/api/v1/capture-jobs/" + action),
        oneAction,
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authenticateCaptureJobs(
        await request(
          reusedClaims,
          "/api/v1/capture-jobs/" + (action === "claim" ? "result" : "claim"),
        ),
        oneAction,
        now,
      ),
    ).rejects.toMatchObject({ status: 403 });
  }
});

it("bearer, Drive and MCP credentials do not replace a signed job assertion", async () => {
  const credentialHeaders: HeadersInit[] = [
    { Authorization: "Bearer synthetic-drive-token" },
    {
      "CF-Access-Client-Id": "inventory.access",
      "CF-Access-Client-Secret": "synthetic",
    },
    { Authorization: "Bearer synthetic-mcp-token" },
  ];
  for (const headers of credentialHeaders)
    await expect(
      authenticateCaptureJobs(
        new Request("https://jobs.example.com/api/v1/capture-jobs/claim", {
          method: "POST",
          headers,
        }),
        reused,
        now,
      ),
    ).rejects.toMatchObject({ status: 401 });
});
it("accepts an explicitly configured future exact episode without accepting wildcard scopes", async () => {
  await expect(
    authenticateCaptureJobs(
      await request(),
      { ...env, CAPTURE_JOBS_GRANT_EPISODE: "128" },
      now,
    ),
  ).resolves.toBeUndefined();
  for (const episode of ["*", "127,128", "0128", "0", "1000000"])
    await expect(
      authenticateCaptureJobs(
        await request(),
        { ...env, CAPTURE_JOBS_GRANT_EPISODE: episode },
        now,
      ),
    ).rejects.toMatchObject({ status: 503 });
});

it.each([-1, 0, 604799999, 604800000])(
  "seven-day job grant preserves exact time boundary %i",
  async (offset) => {
    const at = now + offset;
    const config = {
      ...env,
      CAPTURE_JOBS_GRANT_OPERATIONS: "capture,cut",
      CAPTURE_JOBS_GRANT_STARTS_AT: new Date(now).toISOString(),
      CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 604800000).toISOString(),
    };
    const check = authenticateCaptureJobs(
      await request({
        iat: Math.floor(at / 1000),
        exp: Math.floor(at / 1000) + 600,
      }),
      config,
      at,
    );
    if (offset < 0 || offset >= 604800000)
      await expect(check).rejects.toMatchObject({ status: 403 });
    else await expect(check).resolves.toBeUndefined();
  },
);
it("rejects job grants longer than seven days by one millisecond", async () => {
  await expect(
    authenticateCaptureJobs(
      await request(),
      {
        ...env,
        CAPTURE_JOBS_GRANT_OPERATIONS: "capture,cut",
        CAPTURE_JOBS_GRANT_STARTS_AT: new Date(now).toISOString(),
        CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 604800001).toISOString(),
      },
      now,
    ),
  ).rejects.toMatchObject({ status: 503 });
});

it.each(["plan", "capture,plan", "cut,plan", "capture,cut,plan"])(
  "keeps planning grant %s capped at 24 hours",
  async (operations) => {
    const config = {
      ...env,
      CAPTURE_JOBS_GRANT_OPERATIONS: operations,
      CAPTURE_JOBS_GRANT_STARTS_AT: new Date(now).toISOString(),
      CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 86400000).toISOString(),
    };
    await expect(
      authenticateCaptureJobs(await request(), config, now),
    ).resolves.toBeUndefined();
    config.CAPTURE_JOBS_GRANT_EXPIRES_AT = new Date(
      now + 86400001,
    ).toISOString();
    await expect(
      authenticateCaptureJobs(await request(), config, now),
    ).rejects.toMatchObject({ status: 503 });
  },
);
