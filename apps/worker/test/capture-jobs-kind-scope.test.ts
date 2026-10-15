import type { ClaimResponse } from "../src/capture-jobs/contract";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPair, SignJWT } from "jose";
import worker from "../src/index";
import { csrfToken } from "../src/auth";
import { claimJob, createJob, acceptResult } from "../src/capture-jobs/store";
import type { Env } from "../src/env";
const keys = vi.hoisted(() => ({ public: undefined as CryptoKey | undefined }));
vi.mock("jose", async () => ({
  ...(await vi.importActual<typeof import("jose")>("jose")),
  createRemoteJWKSet: vi.fn(() => async () => keys.public),
}));
let privateKey: CryptoKey, raw: DatabaseSync, env: Env, db: D1Database;
const captureId = "00000000-0000-4000-8000-000000000101",
  cutId = "00000000-0000-4000-8000-000000000102";
const capture = {
  job_id: captureId,
  show: "twib",
  episode: 127,
  url: "https://youtu.be/abcdefghijk",
  reported_by: "chad",
};
const cut = {
  job_id: cutId,
  kind: "cut",
  show: "twib",
  episode: 127,
  reported_by: "chad",
  parent: {
    item_id: "item_" + "a".repeat(64),
    clip_id: "native-parent",
    clip_uid: null,
    ref: "fixture.mp4",
    sha256: "a".repeat(64),
    size_bytes: 100,
    modified_at: null,
  },
  spec: { kind: "range", startSeconds: 2, endSeconds: 4 },
};
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys.public = pair.publicKey;
});
beforeEach(async () => {
  raw = new DatabaseSync(":memory:");
  for (const file of [
    "0012_capture_jobs.sql",
    "0014_inventory_cut_requests.sql",
    "0015_inventory_cut_planning.sql",
    "0016_first_pass_derivative_link.sql",
  ])
    raw.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"),
    );
  const prepare = (sql: string) => {
    let values: (string | number | null)[] = [];
    const statement = {
      bind: (...args: (string | number | null)[]) => {
        values = args;
        return statement;
      },
      first: async () => raw.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: raw.prepare(sql).all(...values) }),
      run: async () => raw.prepare(sql).run(...values),
    };
    return statement;
  };
  db = {
    prepare,
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      raw.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const now = Date.now();
  env = {
    DB: db,
    APP_ENV: "production",
    APP_ORIGIN: "https://fixture.example.com",
    ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
    ACCESS_AUD: "a".repeat(64),
    OWNER_EMAIL: "owner@example.com",
    CSRF_SECRET: "synthetic-csrf-test-only-secret-long-enough",
    CAPTURE_JOBS_ENABLED: "true",
    CUT_REQUESTS_ENABLED: "true",
    CUT_JOBS_ENABLED: "true",
    CAPTURE_JOBS_GRANT_OPERATIONS: "cut",
    CAPTURE_JOBS_APP_ORIGIN: "https://fixture.example.com",
    CAPTURE_JOBS_ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
    CAPTURE_JOBS_ACCESS_AUD: "c".repeat(64),
    CAPTURE_JOBS_ACCESS_CLIENT_ID: "cut-worker.access",
    CAPTURE_JOBS_GRANT_SOURCE_ID: "nomad:capture-worker",
    CAPTURE_JOBS_GRANT_SHOW: "twib",
    CAPTURE_JOBS_GRANT_EPISODE: "127",
    CAPTURE_JOBS_GRANT_SCOPES: "job:claim,job:result",
    CAPTURE_JOBS_GRANT_STARTS_AT: new Date(now - 1000).toISOString(),
    CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(now + 3600000).toISOString(),
  } as Env;
  await createJob(db, capture, "fixture-owner", now);
  raw
    .prepare(
      "INSERT INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) VALUES(?,?,?,'queued','capture',?,?)",
    )
    .run(cutId, JSON.stringify(cut), "fixture-owner", now + 1, now + 1);
  raw
    .prepare(
      "INSERT INTO inventory_cut_requests(request_id,item_id,owner,parent_version,review_revision,request_json,state,created_at,updated_at) VALUES(?,?,?, ?,1,?,'queued',?,?)",
    )
    .run(
      cutId,
      cut.parent.item_id,
      "fixture-owner",
      "a".repeat(64),
      JSON.stringify(cut),
      now,
      now,
    );
});
afterEach(() => raw.close());
async function request(path: string, body: unknown, owner = false) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: "https://fixture.cloudflareaccess.com",
    aud: owner ? env.ACCESS_AUD : env.CAPTURE_JOBS_ACCESS_AUD,
    sub: owner ? "fixture-owner" : "",
    iat: now,
    exp: now + 300,
    ...(owner
      ? { email: env.OWNER_EMAIL }
      : { type: "app", common_name: "cut-worker.access" }),
  })
    .setProtectedHeader({ alg: "RS256" })
    .sign(privateKey);
  return worker.fetch(
    new Request(env.APP_ORIGIN + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Jwt-Assertion": token,
        Origin: env.APP_ORIGIN!,
        "X-CSRF-Token": await csrfToken("fixture-owner", env, false),
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}
const claim = (body: unknown) => request("/api/v1/capture-jobs/claim", body);
const result = (body: unknown) => request("/api/v1/capture-jobs/result", body);
const snapshot = () =>
  JSON.stringify(
    [
      "capture_jobs",
      "capture_job_claims",
      "capture_job_deliveries",
      "capture_job_retries",
      "inventory_cut_requests",
    ].map((table) => raw.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
  );
const row = (id: string) =>
  raw.prepare("SELECT * FROM capture_jobs WHERE job_id=?").get(id);
it.each([{}, { job_kind: "capture" }])(
  "cut-only grant denies default/explicit capture claim without state or receipts %j",
  async (input) => {
    const before = snapshot();
    const response = await claim({ request_id: crypto.randomUUID(), ...input });
    expect(response.status).toBe(403);
    expect(snapshot()).toBe(before);
  },
);
it("cut claim and replay do not expire or mutate unrelated capture leases", async () => {
  raw
    .prepare(
      "UPDATE capture_jobs SET state='running',lease_id=?,lease_expires_at=0,attempt=1 WHERE job_id=?",
    )
    .run(crypto.randomUUID(), captureId);
  const before = row(captureId),
    request_id = crypto.randomUUID();
  const first = await claim({ request_id, job_kind: "cut" });
  expect(first.status).toBe(200);
  const payload = (await first.json()) as ClaimResponse;
  expect(payload.claim?.job_id).toBe(cutId);
  expect(await (await claim({ request_id, job_kind: "cut" })).json()).toEqual(
    payload,
  );
  expect(row(captureId)).toEqual(before);
  const stored = snapshot();
  expect((await claim({ request_id })).status).toBe(403);
  expect(snapshot()).toBe(stored);
});
it("capture grant reciprocally cannot claim or expire cut jobs", async () => {
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture";
  raw
    .prepare(
      "UPDATE capture_jobs SET state='running',lease_id=?,lease_expires_at=0 WHERE job_id=?",
    )
    .run(crypto.randomUUID(), cutId);
  const before = row(cutId);
  expect((await claim({ request_id: crypto.randomUUID() })).status).toBe(200);
  expect(row(cutId)).toEqual(before);
  expect(
    (await claim({ request_id: crypto.randomUUID(), job_kind: "cut" })).status,
  ).toBe(403);
});
it.each([undefined, "", "cut,capture", "cut,unknown", " capture", "*"])(
  "missing/malformed kind grant is closed: %s",
  async (grant) => {
    env.CAPTURE_JOBS_GRANT_OPERATIONS = grant;
    const before = snapshot();
    expect(
      (await claim({ request_id: crypto.randomUUID(), job_kind: "cut" }))
        .status,
    ).toBe(403);
    expect((await claim({ request_id: crypto.randomUUID() })).status).toBe(403);
    expect(snapshot()).toBe(before);
  },
);
it("cut-only grant cannot create or retry capture through owner routes", async () => {
  const before = snapshot();
  for (const [path, body] of [
    ["/api/capture-jobs", { ...capture, job_id: crypto.randomUUID() }],
    [
      "/api/capture-jobs/" + captureId + "/retry",
      { retry_id: crypto.randomUUID() },
    ],
    [
      "/api/capture-jobs/" + cutId + "/retry",
      { retry_id: crypto.randomUUID() },
    ],
  ] as const)
    expect((await request(path, body, true)).status).toBe(403);
  expect(snapshot()).toBe(before);
});
it("owner cut queue/retry rejects capture IDs without modifying them", async () => {
  const before = snapshot();
  for (const action of ["queue", "retry"])
    expect(
      (
        await request(
          `/api/inventory/cut-requests/${captureId}/${action}`,
          { retry_id: crypto.randomUUID() },
          true,
        )
      ).status,
    ).toBe(409);
  expect(snapshot()).toBe(before);
});
it("cut-only grant denies capture results including old valid receipts and leases", async () => {
  const lease = crypto.randomUUID();
  await claimJob(db, { request_id: lease });
  const delivery = {
    delivery_id: crypto.randomUUID(),
    job_id: captureId,
    lease_id: lease,
    state: "needs_review",
    attempt: 1,
    code: "FIXTURE_FAILED",
  };
  await acceptResult(db, delivery);
  const before = snapshot();
  for (const body of [
    delivery,
    { ...delivery, delivery_id: crypto.randomUUID() },
    { ...delivery, lease_id: crypto.randomUUID() },
  ])
    expect((await result(body)).status).toBe(403);
  expect(snapshot()).toBe(before);
});
it("old capture claims cannot replay into a cut scope or leak a claim via a reused lease ID", async () => {
  const request_id = crypto.randomUUID();
  await claimJob(db, { request_id });
  const before = snapshot();
  expect((await claim({ request_id })).status).toBe(403);
  expect((await claim({ request_id, job_kind: "cut" })).status).toBe(409);
  expect(snapshot()).toBe(before);
  raw
    .prepare("DELETE FROM capture_job_claims WHERE request_id=?")
    .run(request_id);
  const response = await claim({ request_id, job_kind: "cut" });
  expect(response.status).toBe(200);
  expect(((await response.json()) as ClaimResponse).claim).toBeNull();
  expect(row(captureId)?.state).toBe("running");
  expect(row(cutId)?.state).toBe("queued");
});
it("cut results require cut scope on current job kind even on matching replay", async () => {
  const request_id = crypto.randomUUID();
  await claim({ request_id, job_kind: "cut" });
  const delivery = {
    delivery_id: crypto.randomUUID(),
    job_id: cutId,
    lease_id: request_id,
    state: "needs_review",
    attempt: 1,
    code: "CUT_READY_FOR_REVIEW",
    result: {
      clip_id: cutId + "-a1",
      parent_clip_id: "native-parent",
      source_long_clip_id: "root-source",
      ref: `new-review/${cutId}-a1.mp4`,
      sha256: "b".repeat(64),
      source_sha256: "a".repeat(64),
      size_bytes: 100,
      duration_seconds: 2,
      local_in_seconds: 2,
      local_out_seconds: 4,
      ready: false,
      approval: "unreviewed",
    },
  };
  const first = await result(delivery);
  expect(first.status).toBe(200);
  expect((await result(delivery)).status).toBe(200);
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture";
  const before = snapshot();
  expect((await result(delivery)).status).toBe(403);
  expect(snapshot()).toBe(before);
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "cut";
  expect((await result({ ...delivery, job_id: captureId })).status).toBe(403);
  expect(
    (
      await result({
        ...delivery,
        delivery_id: crypto.randomUUID(),
        lease_id: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(snapshot()).toBe(before);
});
it("kind-neutral request IDs cannot retarget an empty capture receipt as cut", async () => {
  raw.exec("UPDATE capture_jobs SET state='needs_review'");
  const request_id = crypto.randomUUID();
  expect((await claimJob(db, { request_id })).claim).toBeNull();
  const before = snapshot();
  expect((await claim({ request_id, job_kind: "cut" })).status).toBe(409);
  expect(snapshot()).toBe(before);
});
it("capture-authorized owner generic retry still cannot bypass cut review eligibility", async () => {
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture,cut";
  const before = snapshot();
  expect(
    (
      await request(
        `/api/capture-jobs/${cutId}/retry`,
        { retry_id: crypto.randomUUID() },
        true,
      )
    ).status,
  ).toBe(409);
  expect(snapshot()).toBe(before);
});

it("capture-authorized machine can claim, acknowledge and replay only capture", async () => {
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture";
  const request_id = crypto.randomUUID(),
    before = row(cutId);
  expect((await claim({ request_id })).status).toBe(200);
  const delivery = {
    delivery_id: crypto.randomUUID(),
    job_id: captureId,
    lease_id: request_id,
    state: "succeeded",
    attempt: 1,
    code: null,
  };
  expect((await result(delivery)).status).toBe(200);
  expect((await result(delivery)).status).toBe(200);
  expect(row(cutId)).toEqual(before);
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "cut";
  const stored = snapshot();
  expect((await result(delivery)).status).toBe(403);
  expect(snapshot()).toBe(stored);
});
it("revoked cut execution gate denies receipt replay and claims before mutation", async () => {
  const request_id = crypto.randomUUID();
  await claim({ request_id, job_kind: "cut" });
  const delivery = {
    delivery_id: crypto.randomUUID(),
    job_id: cutId,
    lease_id: request_id,
    state: "needs_review",
    attempt: 1,
    code: "CUT_FAILED_FIXTURE",
  };
  expect((await result(delivery)).status).toBe(200);
  env.CUT_JOBS_ENABLED = "false";
  const stored = snapshot();
  expect((await result(delivery)).status).toBe(503);
  expect((await claim({ request_id, job_kind: "cut" })).status).toBe(503);
  expect(snapshot()).toBe(stored);
});
it("plan is a distinct capability, closed by default, with no capture/cut fallback", async () => {
  const before = snapshot();
  expect(
    (await claim({ request_id: crypto.randomUUID(), job_kind: "plan" })).status,
  ).toBe(403);
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "plan";
  expect(
    (await claim({ request_id: crypto.randomUUID(), job_kind: "plan" })).status,
  ).toBe(503);
  expect(snapshot()).toBe(before);
  env.CUT_PLANNING_ENABLED = "true";
  expect(
    (await claim({ request_id: crypto.randomUUID(), job_kind: "cut" })).status,
  ).toBe(403);
  expect((await claim({ request_id: crypto.randomUUID() })).status).toBe(403);
  const response = await claim({
    request_id: crypto.randomUUID(),
    job_kind: "plan",
  });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { claim: unknown }).claim).toBeNull();
});
it("plan receipt replay is denied when scope or gate is revoked", async () => {
  const plan = {
    ...cut,
    kind: "plan",
    spec: { kind: "first_pass" },
    planning: {
      parentVersion: "a".repeat(64),
      reviewRevision: 1,
      requestRevision: "b".repeat(64),
    },
  };
  raw
    .prepare("UPDATE capture_jobs SET request_json=? WHERE job_id=?")
    .run(JSON.stringify(plan), cutId);
  const delivery = {
    delivery_id: crypto.randomUUID(),
    job_id: cutId,
    lease_id: crypto.randomUUID(),
    state: "needs_review",
    attempt: 1,
    code: "CONTEXT_MISSING",
  };
  raw
    .prepare(
      "INSERT INTO capture_job_deliveries(delivery_id,request_json,response_json) VALUES(?,?,?)",
    )
    .run(
      delivery.delivery_id,
      JSON.stringify(delivery),
      JSON.stringify({ accepted: true }),
    );
  const before = snapshot();
  expect((await result(delivery)).status).toBe(403);
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "plan";
  expect((await result(delivery)).status).toBe(503);
  expect(snapshot()).toBe(before);
  env.CUT_PLANNING_ENABLED = "true";
  expect((await result(delivery)).status).toBe(200);
});
