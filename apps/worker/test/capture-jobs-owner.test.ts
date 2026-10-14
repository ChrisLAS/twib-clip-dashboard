import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { csrfToken } from "../src/auth";
import type { Env } from "../src/env";
const keys = vi.hoisted(() => ({ public: undefined as CryptoKey | undefined }));
vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => async () => keys.public),
  };
});
let privateKey: CryptoKey, sqlite: DatabaseSync, env: Env;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys.public = pair.publicKey;
});
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0012_capture_jobs.sql", import.meta.url),
      "utf8",
    ),
  );
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const statement = {
      bind: (...args: (string | number | null)[]) => {
        values = args;
        return statement;
      },
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
      run: async () => sqlite.prepare(sql).run(...values),
    };
    return statement;
  };
  env = {
    APP_ENV: "production",
    APP_ORIGIN: "https://owner.example.com",
    ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    OWNER_EMAIL: "owner@example.com",
    CSRF_SECRET: "synthetic-test-only-secret-at-least-24",
    CAPTURE_JOBS_ENABLED: "true",
    CAPTURE_JOBS_GRANT_OPERATIONS: "capture",
    DB: { prepare } as unknown as D1Database,
  } as Env;
});
afterEach(() => sqlite.close());
const input = {
  job_id: "00000000-0000-4000-8000-000000000001",
  show: "twib",
  episode: 127,
  url: "https://youtu.be/abcdefghijk",
  reported_by: "chad",
};
async function token(machine = false) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "https://synthetic.cloudflareaccess.com",
    aud: env.ACCESS_AUD,
    sub: "synthetic-owner",
    iat: now,
    exp: now + 300,
    ...(machine
      ? { type: "app", common_name: "machine.access" }
      : { email: env.OWNER_EMAIL }),
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
}
async function request({
  jwt,
  origin,
  csrf,
  method = "POST",
  path = "/api/capture-jobs",
}: {
  jwt?: string;
  origin?: string;
  csrf?: string;
  method?: string;
  path?: string;
}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
  if (origin) headers.set("Origin", origin);
  if (csrf) headers.set("X-CSRF-Token", csrf);
  return worker.fetch(
    new Request(env.APP_ORIGIN + path, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    }),
    env,
  );
}
it("owner routes reject missing assertion and service JWT before writes", async () => {
  expect((await request({})).status).toBe(401);
  expect((await request({ jwt: await token(true) })).status).toBe(401);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n,
  ).toBe(0);
});
it("real synthetic owner JWT still requires exact origin and CSRF for creation", async () => {
  const jwt = await token(),
    csrf = await csrfToken("synthetic-owner", env, false);
  expect((await request({ jwt, csrf })).status).toBe(403);
  expect(
    (await request({ jwt, origin: env.APP_ORIGIN, csrf: "invalid" })).status,
  ).toBe(403);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n,
  ).toBe(0);
  expect((await request({ jwt, origin: env.APP_ORIGIN, csrf })).status).toBe(
    200,
  );
  expect((await request({ jwt, origin: env.APP_ORIGIN, csrf })).status).toBe(
    200,
  );
  const list = await request({ jwt, method: "GET" });
  expect(list.status).toBe(200);
  expect(((await list.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
});
it("retry requires CSRF and does not modify the existing job on rejection", async () => {
  const jwt = await token(),
    csrf = await csrfToken("synthetic-owner", env, false);
  await request({ jwt, origin: env.APP_ORIGIN, csrf });
  expect(
    (
      await request({
        jwt,
        origin: env.APP_ORIGIN,
        path: "/api/capture-jobs/" + input.job_id + "/retry",
      })
    ).status,
  ).toBe(403);
  expect(sqlite.prepare("SELECT state FROM capture_jobs").get()?.state).toBe(
    "queued",
  );
});
it("disabled owner gate rejects before authentication or JSON parsing", async () => {
  env.CAPTURE_JOBS_ENABLED = "false";
  const response = await worker.fetch(
    new Request(env.APP_ORIGIN + "/api/capture-jobs", {
      method: "POST",
      body: "not JSON",
    }),
    env,
  );
  expect(response.status).toBe(503);
  expect(
    sqlite.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n,
  ).toBe(0);
});
