import { beforeEach, afterEach, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { Env } from "../src/env";
import {
  requestIntakeWork,
  selectIntakeRange,
  listIntakeWork,
  retryIntakeWork,
  advanceIntakeWork,
} from "../src/capture-jobs/intake-work";
import { claimJob, acceptResult } from "../src/capture-jobs/store";
import {
  inventoryEpisodeId,
  INVENTORY_SOURCE,
} from "../src/inventory/contract";
import { readCut, enqueueCut, eligibility } from "../src/capture-jobs/cut";
let raw: DatabaseSync, db: D1Database, env: Env;
class Statement {
  values: (string | number | null)[] = [];
  constructor(private sql: string) {}
  bind(...v: (string | number | null)[]) {
    this.values = v;
    return this;
  }
  async first<T>() {
    return (raw.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all<T>() {
    return { results: raw.prepare(this.sql).all(...this.values) as T[] };
  }
  async run() {
    return raw.prepare(this.sql).run(...this.values);
  }
}
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function intake(n = 1, range?: [number, number], notes = "") {
  const data = {
    id: "intake-" + n,
    episodeId: "draft",
    kind: "full_source",
    submittedUrl: "https://youtu.be/abcdefghijk",
    canonicalUrl: "https://youtu.be/abcdefghijk",
    provider: "youtube",
    inMs: range?.[0] ?? null,
    outMs: range?.[1] ?? null,
    whyItMatters: notes,
    status: "awaiting_processing",
    revision: 1,
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
  };
  raw
    .prepare(
      "INSERT INTO manual_intake(id,owner,episode_id,canonical_url,in_ms,out_ms,status,revision,data) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      data.id,
      "owner",
      "draft",
      data.canonicalUrl,
      data.inMs,
      data.outMs,
      data.status,
      1,
      JSON.stringify(data),
    );
  return data;
}
function edit(n = 1) {
  raw
    .prepare(
      "UPDATE manual_intake SET revision=2,data=json_set(data,'$.revision',2,'$.whyItMatters','new intent') WHERE id=?",
    )
    .run("intake-" + n);
}
function enabled() {
  env.CAPTURE_JOBS_ENABLED = "true";
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture,cut,plan";
  env.CAPTURE_JOBS_GRANT_EPISODE = "128";
}
const scope = { episode: 128, intakeEnabled: true };
beforeEach(() => {
  raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const n of readdirSync(dir).sort())
    raw.exec(readFileSync(new URL(n, dir), "utf8"));
  db = {
    prepare: (s: string) => new Statement(s),
    batch: async (ss: Statement[]) => {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of ss) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  env = {
    DB: db,
    INTAKE_WORK_REQUESTS_ENABLED: "true",
    CUT_REQUESTS_ENABLED: "true",
  } as Env;
  raw
    .prepare(
      "INSERT INTO episode_workspaces(id,data,status,is_active,revision) VALUES('draft',?,'draft',1,1)",
    )
    .run(
      JSON.stringify({ id: "draft", number: 128, title: "Synthetic draft" }),
    );
});
afterEach(() => raw.close());
it("saves durable immutable intent with all processing off and exact replay, without reviews", async () => {
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    100,
  );
  expect(a.stage).toBe("saved");
  expect(a.code).toBe("PROCESSING_DISABLED");
  expect(a.episodeNumber).toBe(128);
  expect(
    await requestIntakeWork(
      env,
      "intake-1",
      { expectedRevision: 1, priority: "normal" },
      "owner",
      200,
    ),
  ).toEqual(a);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
  expect(raw.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n).toBe(
    0,
  );
  expect((await claimJob(db, { request_id: id(1) }, 300)).claim).toBeNull();
  await expect(
    requestIntakeWork(
      env,
      "intake-1",
      { expectedRevision: 1, priority: "urgent" },
      "owner",
    ),
  ).rejects.toMatchObject({ code: "INTAKE_WORK_CONFLICT" });
});
it("request gate unavailable and owner/episode constraints fail closed", async () => {
  intake();
  expect(
    (
      await listIntakeWork(
        { ...env, INTAKE_WORK_REQUESTS_ENABLED: undefined },
        "owner",
      )
    ).enabled,
  ).toBe(false);
  await expect(
    requestIntakeWork(
      { ...env, INTAKE_WORK_REQUESTS_ENABLED: undefined },
      "intake-1",
      { expectedRevision: 1, priority: "normal" },
      "owner",
    ),
  ).rejects.toMatchObject({ status: 503 });
  await expect(
    requestIntakeWork(
      env,
      "intake-1",
      { expectedRevision: 1, priority: "normal" },
      "other",
    ),
  ).rejects.toMatchObject({ status: 404 });
  raw.exec(
    "UPDATE episode_workspaces SET is_active=0,status='published',revision=2",
  );
  await expect(
    requestIntakeWork(
      env,
      "intake-1",
      { expectedRevision: 1, priority: "normal" },
      "owner",
    ),
  ).rejects.toMatchObject({ code: "ACTIVE_EPISODE_REQUIRED" });
});
it("urgent jobs precede queued normal jobs without changing active leases; exact episode/gate enforced", async () => {
  enabled();
  intake(1, [0, 10000]);
  intake(2, [10000, 20000]);
  intake(3, [20000, 30000]);
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  const running = await claimJob(db, { request_id: id(1) }, 5, scope);
  expect(running.claim?.job_id).toBe(a.jobId);
  await requestIntakeWork(
    env,
    "intake-2",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    6,
  );
  const urgent = await requestIntakeWork(
    env,
    "intake-3",
    { expectedRevision: 1, priority: "urgent" },
    "owner",
    7,
  );
  expect(
    (
      await claimJob(db, { request_id: id(2) }, 8, {
        episode: 127,
        intakeEnabled: true,
      })
    ).claim,
  ).toBeNull();
  expect(
    (
      await claimJob(db, { request_id: id(3) }, 8, {
        episode: 128,
        intakeEnabled: false,
      })
    ).claim,
  ).toBeNull();
  expect(
    (await claimJob(db, { request_id: id(4) }, 9, scope)).claim?.job_id,
  ).toBe(urgent.jobId);
  expect(
    raw.prepare("SELECT lease_id FROM capture_jobs WHERE job_id=?").get(a.jobId)
      ?.lease_id,
  ).toBe(id(1));
  await expect(
    claimJob(db, { request_id: id(1) }, 10, {
      episode: 127,
      intakeEnabled: true,
    }),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
});
it("edits after enqueue and episode release block claims and stale claim replay", async () => {
  enabled();
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  await claimJob(db, { request_id: id(1) }, 2, scope);
  edit();
  await expect(
    claimJob(db, { request_id: id(1) }, 3, scope),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
  expect((await listIntakeWork(env, "owner")).jobs[0].stale).toBe(true);
  expect(
    (
      await requestIntakeWork(
        env,
        "intake-1",
        { expectedRevision: 1, priority: "normal" },
        "owner",
      )
    ).jobId,
  ).toBe(a.jobId);
});
it("same URL distinct intended ranges remain independent; new revisions never overwrite old intent", async () => {
  intake(1, [0, 10000]);
  intake(2, [10000, 20000]);
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
  );
  const b = await requestIntakeWork(
    env,
    "intake-2",
    { expectedRevision: 1, priority: "normal" },
    "owner",
  );
  expect(a.jobId).not.toBe(b.jobId);
  edit();
  const c = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 2, priority: "normal" },
    "owner",
  );
  expect(c.jobId).not.toBe(a.jobId);
  expect(
    raw.prepare("SELECT count(*) n FROM intake_work_requests").get()?.n,
  ).toBe(3);
});
it("explicit retry releases saved work only with exact configured scope; uncertain replay does not duplicate", async () => {
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
  );
  await expect(
    retryIntakeWork(env, "intake-1", a.jobId, { expectedAttempt: 0 }, "owner"),
  ).rejects.toMatchObject({ status: 503 });
  enabled();
  const b = await retryIntakeWork(
    env,
    "intake-1",
    a.jobId,
    { expectedAttempt: 0 },
    "owner",
  );
  expect(b.stage).toBe("queued");
  expect(
    (
      await retryIntakeWork(
        env,
        "intake-1",
        a.jobId,
        { expectedAttempt: 0 },
        "owner",
      )
    ).stage,
  ).toBe("queued");
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
async function captured(range?: [number, number]) {
  enabled();
  intake(1, range);
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  const claim = (await claimJob(db, { request_id: id(1) }, 2, scope)).claim!;
  const proof = {
    version: 1,
    job_id: a.jobId,
    ref: `new-review/${a.jobId}-a1.mp4`,
    sha256: "a".repeat(64),
    size_bytes: 100,
    duration_seconds: 600,
    show: "twib",
    episode: 128,
    editorial_ready: false,
  };
  const receipt = {
    delivery_id: id(2),
    job_id: a.jobId,
    lease_id: claim.lease_id,
    state: "succeeded",
    attempt: 1,
    code: null,
    capture: proof,
  };
  await acceptResult(db, receipt, 3);
  return { a, proof, receipt };
}
async function observe(proof: {
  ref: string;
  sha256: string;
  size_bytes: number;
  duration_seconds: number;
}) {
  const item = {
    id: "item_" + "b".repeat(64),
    kind: "media",
    media: {
      ref: proof.ref,
      present: true,
      size_bytes: proof.size_bytes,
      modified_at: null,
      duration_seconds: proof.duration_seconds,
    },
    producer_record: {
      clip_id: "synthetic-native",
      clip_uid: "synthetic-native",
      source_long_clip_id: null,
      parent_clip_id: null,
    },
    capture_evidence: [
      {
        artifact: "capture/synthetic.json",
        matches_observed_size: true,
        content_hash_verified: false,
        streams_reprobed: false,
        producer_sha256: proof.sha256,
      },
    ],
    observations: [],
    origins: [],
    processing_status: "captured",
    ready: false,
  };
  const ep = await inventoryEpisodeId(128);
  raw
    .prepare(
      "INSERT INTO inventory_items(source_id,episode_id,item_id) VALUES(?,?,?)",
    )
    .run(INVENTORY_SOURCE, ep, item.id);
  raw
    .prepare(
      "INSERT INTO inventory_snapshots(receipt_id,source_id,episode_id,digest,scan_id,sequence,envelope_hash,payload_hash,observed_ms,accepted_at,manifest_json,receipt_json) VALUES('receipt',?,?,'d','scan',1,'h','p',1,'2026-10-16T00:00:00Z','{}','{}')",
    )
    .run(INVENTORY_SOURCE, ep);
  raw
    .prepare(
      "INSERT INTO inventory_observations(receipt_id,source_id,episode_id,item_id,sequence,item_json,observed_ms) VALUES(?,?,?,?,?,?,1)",
    )
    .run(
      "receipt",
      INVENTORY_SOURCE,
      await inventoryEpisodeId(128),
      item.id,
      1,
      JSON.stringify(item),
    );
  return item;
}
it("verified capture waits for native inventory then creates unreviewed intent-backed range without human review", async () => {
  const { a, proof, receipt } = await captured([1000, 12000]);
  await advanceIntakeWork(env, a.jobId);
  expect((await listIntakeWork(env, "owner")).jobs[0].code).toBe(
    "AWAITING_INVENTORY",
  );
  await observe(proof);
  await advanceIntakeWork(env, a.jobId);
  const w = raw
    .prepare("SELECT cut_request_id FROM intake_work_requests")
    .get();
  expect(w?.cut_request_id).toBeTruthy();
  expect(raw.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n).toBe(
    0,
  );
  const cut = await readCut(db, String(w!.cut_request_id));
  expect(cut?.review_revision).toBe(0);
  expect(JSON.parse(cut!.request_json).episode).toBe(128);
  expect(JSON.parse(cut!.request_json).spec.kind).toBe("range");
  await eligibility(db, cut!);
  env.CUT_JOBS_ENABLED = "true";
  await advanceIntakeWork(env, a.jobId);
  expect(
    (
      await claimJob(
        db,
        { request_id: id(3), job_kind: "cut" },
        Date.now(),
        scope,
      )
    ).claim?.job_id,
  ).toBe(cut?.request_id);
  expect(await acceptResult(db, receipt, 4)).toMatchObject({ accepted: true });
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(1);
  edit();
  await expect(enqueueCut(db, cut!.request_id, "owner")).resolves.toBeTruthy();
  await expect(eligibility(db, cut!)).rejects.toMatchObject({ status: 409 });
});
it("capture proof rejects other job/episode/hash fields and legacy receipts cannot auto-chain", async () => {
  enabled();
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  await claimJob(db, { request_id: id(1) }, 2, scope);
  await expect(
    acceptResult(
      db,
      {
        delivery_id: id(2),
        job_id: a.jobId,
        lease_id: id(1),
        state: "succeeded",
        attempt: 1,
        code: null,
        capture: {
          version: 1,
          job_id: id(9),
          ref: "new-review/s.mp4",
          sha256: "a".repeat(64),
          size_bytes: 10,
          duration_seconds: 10,
          show: "twib",
          episode: 128,
          editorial_ready: false,
        },
      },
      3,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await acceptResult(
    db,
    {
      delivery_id: id(2),
      job_id: a.jobId,
      lease_id: id(1),
      state: "succeeded",
      attempt: 1,
      code: null,
    },
    3,
  );
  await advanceIntakeWork(env, a.jobId);
  expect((await listIntakeWork(env, "owner")).jobs[0].code).toBe(
    "CAPTURE_PROOF_REQUIRED",
  );
});
it("context-only intent flows through existing plan and auto-cut with provenance, never human approval", async () => {
  const { a, proof } = await captured();
  await observe(proof);
  env.CUT_PLANNING_ENABLED = "true";
  await advanceIntakeWork(env, a.jobId);
  const plan = (
    await claimJob(
      db,
      { request_id: id(10), job_kind: "plan" },
      Date.now(),
      scope,
    )
  ).claim!;
  expect(plan.kind).toBe("plan");
  if (plan.kind !== "plan") throw Error("missing plan");
  expect(plan.intake_work_id).toBe(a.jobId);
  const proposal = {
    binding: "d".repeat(64),
    contextRevision: "e".repeat(64),
    transcriptRevision: "f".repeat(64),
    requestRevision: plan.planning.requestRevision,
    sourceSha256: proof.sha256,
    range: { kind: "range", startSeconds: 1, endSeconds: 12 },
    rationale: "Synthetic narrative context payoff",
    ready: false,
    approval: "unreviewed",
  };
  const input = {
    delivery_id: id(11),
    job_id: plan.job_id,
    lease_id: plan.lease_id,
    state: "needs_review",
    attempt: 1,
    code: "EDITORIAL_PROPOSAL_READY",
    proposal,
  };
  await acceptResult(db, input);
  const { transitionAfterReceipt } = await import("../src/capture-jobs/plan");
  env.CUT_JOBS_ENABLED = "true";
  env.CUT_FIRST_PASS_AUTO_ENABLED = "true";
  await transitionAfterReceipt(env, plan.job_id);
  const child = raw
    .prepare(
      "SELECT request_id,request_json,review_revision FROM inventory_cut_requests WHERE source_plan_request_id=?",
    )
    .get(plan.job_id);
  expect(child).toBeTruthy();
  expect(child?.review_revision).toBe(0);
  expect(JSON.parse(String(child?.request_json)).intake_work_id).toBe(a.jobId);
  expect(raw.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n).toBe(
    0,
  );
  expect(raw.prepare("SELECT count(*) n FROM renders").get()?.n).toBe(0);
  const cut = (
    await claimJob(
      db,
      { request_id: id(12), job_kind: "cut" },
      Date.now(),
      scope,
    )
  ).claim;
  expect(cut?.job_id).toBe(child?.request_id);
  await acceptResult(db, input);
  await transitionAfterReceipt(env, plan.job_id);
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(2);
});
it("existing manual review blocks intake transition and later edits never overwrite manual decisions", async () => {
  const { a, proof } = await captured();
  const item = await observe(proof);
  raw
    .prepare(
      "INSERT INTO inventory_reviews(source_id,episode_id,review_key,item_id,revision,status,notes,reason,reviewed_version,version_basis,saved_at,owner) VALUES(?,?,?, ?,1,'rejected','human notes','human reason','version','basis','2026-10-16T00:00:00Z','owner')",
    )
    .run(INVENTORY_SOURCE, await inventoryEpisodeId(128), item.id, item.id);
  const before = JSON.stringify(
    raw.prepare("SELECT * FROM inventory_reviews").all(),
  );
  await advanceIntakeWork(env, a.jobId);
  expect((await listIntakeWork(env, "owner")).jobs[0].code).toBe(
    "MANUAL_REVIEW_PRESENT",
  );
  edit();
  await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 2, priority: "normal" },
    "owner",
  );
  expect(
    JSON.stringify(raw.prepare("SELECT * FROM inventory_reviews").all()),
  ).toBe(before);
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(0);
});
it("episode release between receipt and inventory never follows another active episode", async () => {
  const { a, proof } = await captured();
  await observe(proof);
  raw.exec(
    "UPDATE episode_workspaces SET status='published',is_active=0,revision=2 WHERE id='draft'",
  );
  await advanceIntakeWork(env, a.jobId);
  expect((await listIntakeWork(env, "owner")).jobs[0].stale).toBe(true);
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(0);
});

it("retries only the exact downstream stage and attempt, preserving completed capture", async () => {
  const { a, proof } = await captured([1000, 12000]);
  await observe(proof);
  await advanceIntakeWork(env, a.jobId);
  let v = (await listIntakeWork(env, "owner")).jobs[0];
  const target = v.cutRequest!.requestId;
  expect(v.retryTargetId).toBe(target);
  expect(v.retryable).toBe(true);
  env.CUT_JOBS_ENABLED = "true";
  v = await retryIntakeWork(
    env,
    "intake-1",
    a.jobId,
    { expectedAttempt: 0, expectedTargetId: target },
    "owner",
    10,
  );
  expect(v.stage).toBe("queued");
  await claimJob(db, { request_id: id(20), job_kind: "cut" }, 11, scope);
  await acceptResult(
    db,
    {
      delivery_id: id(21),
      job_id: target,
      lease_id: id(20),
      state: "needs_review",
      attempt: 1,
      code: "CUT_FAILED_SYNTHETIC",
    },
    12,
  );
  v = (await listIntakeWork(env, "owner")).jobs[0];
  expect(v.retryable).toBe(true);
  expect(v.attempt).toBe(1);
  const retry = { expectedAttempt: 1, expectedTargetId: target };
  expect(
    (await retryIntakeWork(env, "intake-1", a.jobId, retry, "owner", 13)).stage,
  ).toBe("queued");
  expect(
    (await retryIntakeWork(env, "intake-1", a.jobId, retry, "owner", 14)).stage,
  ).toBe("queued");
  expect(
    raw.prepare("SELECT count(*) n FROM capture_job_retries").get()?.n,
  ).toBe(1);
  expect(
    raw.prepare("SELECT state FROM capture_jobs WHERE job_id=?").get(a.jobId)
      ?.state,
  ).toBe("succeeded");
  await retryIntakeWork(
    env,
    "intake-1",
    a.jobId,
    { expectedAttempt: 1, expectedTargetId: a.jobId },
    "owner",
    15,
  );
  expect(
    raw.prepare("SELECT count(*) n FROM capture_job_retries").get()?.n,
  ).toBe(1);
  edit();
  await expect(
    retryIntakeWork(env, "intake-1", a.jobId, retry, "owner", 16),
  ).rejects.toMatchObject({ status: 409 });
});
it("retries a context-missing plan without creating a human review or new request", async () => {
  const { a, proof } = await captured();
  await observe(proof);
  env.CUT_PLANNING_ENABLED = "true";
  await advanceIntakeWork(env, a.jobId);
  const target = (await listIntakeWork(env, "owner")).jobs[0].cutRequest!
    .requestId;
  await claimJob(
    db,
    { request_id: id(30), job_kind: "plan" },
    Date.now(),
    scope,
  );
  await acceptResult(
    db,
    {
      delivery_id: id(31),
      job_id: target,
      lease_id: id(30),
      state: "needs_review",
      attempt: 1,
      code: "CONTEXT_MISSING",
    },
    Date.now(),
  );
  const v = await retryIntakeWork(
    env,
    "intake-1",
    a.jobId,
    { expectedAttempt: 1, expectedTargetId: target },
    "owner",
  );
  expect(v.stage).toBe("queued");
  expect(v.attempt).toBe(1);
  expect(raw.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n).toBe(
    0,
  );
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(1);
});
it("rejects running acknowledgment and its replay after intake revision changes", async () => {
  enabled();
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  await claimJob(db, { request_id: id(40) }, 2, scope);
  const running = {
    delivery_id: id(41),
    job_id: a.jobId,
    lease_id: id(40),
    state: "running",
    attempt: 1,
    code: "DOWNLOADING",
  };
  await acceptResult(db, running, 3);
  edit();
  await expect(acceptResult(db, running, 4)).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    acceptResult(db, { ...running, delivery_id: id(42) }, 4),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    raw.prepare("SELECT count(*) n FROM capture_job_deliveries").get()?.n,
  ).toBe(1);
});
it("preserves transport capacity and creates no orphan work when full", async () => {
  raw.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) SELECT 'full-'||x,'{}','owner','queued','capture',1,1 FROM n",
  );
  intake();
  await expect(
    requestIntakeWork(
      env,
      "intake-1",
      { expectedRevision: 1, priority: "normal" },
      "owner",
    ),
  ).rejects.toMatchObject({ status: 429, code: "JOB_CAPACITY" });
  expect(
    raw.prepare("SELECT count(*) n FROM intake_work_requests").get()?.n,
  ).toBe(0);
});

it("capture proof binds current job and positive attempt basename with worker-supported extension", async () => {
  enabled();
  intake();
  const a = await requestIntakeWork(
    env,
    "intake-1",
    { expectedRevision: 1, priority: "normal" },
    "owner",
    1,
  );
  await claimJob(db, { request_id: id(60) }, 2, scope);
  const proof = {
    version: 1,
    job_id: a.jobId,
    ref: `new-review/${a.jobId}-a1.mp4`,
    sha256: "a".repeat(64),
    size_bytes: 100,
    duration_seconds: 3,
    show: "twib",
    episode: 128,
    editorial_ready: false,
  };
  const delivery = {
    delivery_id: id(61),
    job_id: a.jobId,
    lease_id: id(60),
    state: "succeeded",
    attempt: 1,
    code: null,
    capture: proof,
  };
  for (const ref of [
    `new-review/${id(99)}-a1.mp4`,
    `new-review/${a.jobId}-a2.mp4`,
    `new-review/${a.jobId}-a1.exe`,
    `new-review/${a.jobId}-a1xmp4`,
  ])
    await expect(
      acceptResult(db, { ...delivery, capture: { ...proof, ref } }, 3),
    ).rejects.toMatchObject({ status: 409 });
  await expect(
    acceptResult(
      db,
      {
        ...delivery,
        attempt: 0,
        capture: { ...proof, ref: `new-review/${a.jobId}-a0.mp4` },
      },
      3,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    raw.prepare("SELECT count(*) n FROM capture_job_deliveries").get()?.n,
  ).toBe(0);
  await acceptResult(
    db,
    {
      ...delivery,
      capture: { ...proof, ref: `new-review/${a.jobId}-a1.webm` },
    },
    3,
  );
});

it("reconciles an earlier uncertain retry after target advances and dispatch is disabled without mutation", async () => {
  const { a, proof } = await captured([1000, 12000]);
  await observe(proof);
  await advanceIntakeWork(env, a.jobId);
  const before = raw
    .prepare("SELECT * FROM capture_jobs ORDER BY job_id")
    .all();
  env.CAPTURE_JOBS_ENABLED = "false";
  env.CAPTURE_JOBS_GRANT_EPISODE = undefined;
  const view = await retryIntakeWork(
    env,
    "intake-1",
    a.jobId,
    { expectedAttempt: 0, expectedTargetId: a.jobId },
    "owner",
  );
  expect(view.retryTargetId).not.toBe(a.jobId);
  expect(
    raw.prepare("SELECT * FROM capture_jobs ORDER BY job_id").all(),
  ).toEqual(before);
  expect(
    raw.prepare("SELECT count(*) n FROM capture_job_retries").get()?.n,
  ).toBe(0);
});

async function manualRangeFixture() {
  const { a, proof } = await captured();
  await observe(proof);
  await advanceIntakeWork(env, a.jobId);
  env.CUT_JOBS_ENABLED = "true";
  env.CUT_PLANNING_ENABLED = "false";
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture,cut";
  env.CAPTURE_JOBS_GRANT_SOURCE_ID = "nomad:capture-worker";
  env.CAPTURE_JOBS_GRANT_SHOW = "twib";
  env.CAPTURE_JOBS_GRANT_SCOPES = "job:claim,job:result";
  env.CAPTURE_JOBS_GRANT_STARTS_AT = new Date(1000).toISOString();
  env.CAPTURE_JOBS_GRANT_EXPIRES_AT = new Date(7201000).toISOString();
  const view = (await listIntakeWork(env, "owner")).jobs[0];
  const input = {
    ...view.rangeSelection!,
    range: { kind: "range" as const, startSeconds: 10, endSeconds: 30 },
  };
  const select = (value: unknown = input, owner = "owner", now = 2000) =>
    selectIntakeRange(env, "intake-1", a.jobId, value, owner, now);
  return { a, proof, view, input, select };
}
it("owner range reuses captured128 with planning off, immutable history, linked tracking and no recapture", async () => {
  const f = await manualRangeFixture();
  const before = JSON.stringify(
    raw.prepare("SELECT * FROM intake_work_requests").all(),
  );
  const intakeBefore = JSON.stringify(
    raw.prepare("SELECT * FROM manual_intake").all(),
  );
  const parentBefore = JSON.stringify(
    await readCut(db, f.input.expectedCutRequestId),
  );
  const result = await f.select();
  expect(result.selectionOrigin).toBe("owner_range");
  expect(await f.select()).toEqual(result);
  // Acknowledgement of the same committed choice survives grant expiry.
  expect(await f.select(f.input, "owner", 7201000)).toEqual(result);
  expect(
    JSON.stringify(raw.prepare("SELECT * FROM intake_work_requests").all()),
  ).toBe(before);
  expect(JSON.stringify(raw.prepare("SELECT * FROM manual_intake").all())).toBe(
    intakeBefore,
  );
  expect(JSON.stringify(await readCut(db, f.input.expectedCutRequestId))).toBe(
    parentBefore,
  );
  expect(raw.prepare("SELECT count(*) n FROM inventory_reviews").get()?.n).toBe(
    0,
  );
  const view = (await listIntakeWork(env, "owner")).jobs[0];
  expect(view.cutRequest?.requestId).toBe(result.requestId);
  expect(view.cutRequest?.selectionOrigin).toBe("owner_range");
  expect(view.stage).toBe("queued");
  const child = await readCut(db, result.requestId);
  const wire = JSON.parse(child!.request_json);
  expect(wire.intake_work_id).toBe(f.a.jobId);
  expect(wire.editorial).toBeUndefined();
  expect(child?.proposal_json).toBeNull();
  expect(child?.review_revision).toBe(0);
  expect(wire.parent).toEqual(
    JSON.parse((await readCut(db, f.input.expectedCutRequestId))!.request_json)
      .parent,
  );
  const claimed = await claimJob(
    db,
    { request_id: id(100), job_kind: "cut" },
    3000,
    scope,
  );
  expect(claimed.claim?.job_id).toBe(result.requestId);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(2);
  expect(
    raw.prepare("SELECT state FROM capture_jobs WHERE job_id=?").get(f.a.jobId)
      ?.state,
  ).toBe("succeeded");
  env.CUT_PLANNING_ENABLED = "true";
  env.CAPTURE_JOBS_GRANT_OPERATIONS = "capture,cut,plan";
  await advanceIntakeWork(env, f.a.jobId);
  await expect(
    enqueueCut(db, f.input.expectedCutRequestId, "owner", 4000, true),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    raw
      .prepare("SELECT count(*) n FROM capture_jobs WHERE job_id=?")
      .get(f.input.expectedCutRequestId)?.n,
  ).toBe(0);
});
it("owner range conflicts on a changed choice and cannot replay across owners or superseded intent", async () => {
  const f = await manualRangeFixture();
  await f.select();
  await expect(
    f.select({
      ...f.input,
      range: { kind: "range", startSeconds: 11, endSeconds: 30 },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(f.select(f.input, "other-owner")).rejects.toMatchObject({
    status: 409,
  });
  edit();
  await expect(f.select()).rejects.toMatchObject({ status: 409 });
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(2);
});
it.each([
  { expectedRevision: 2 },
  { expectedWorkspaceRevision: 2 },
  { episodeNumber: 127 },
  { expectedParentVersion: "c".repeat(64) },
  { expectedRequestRevision: "c".repeat(64) },
  { expectedCutRequestId: id(999) },
])("owner range rejects stale/wrong binding %j", async (change) => {
  const f = await manualRangeFixture();
  await expect(f.select({ ...f.input, ...change })).rejects.toMatchObject({
    status: 409,
  });
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
it.each([
  { kind: "range", startSeconds: -1, endSeconds: 10 },
  { kind: "range", startSeconds: 10, endSeconds: 10 },
  { kind: "range", startSeconds: 0, endSeconds: 181 },
  { kind: "range", startSeconds: 0.0001, endSeconds: 10 },
  { kind: "range", startSeconds: 599, endSeconds: 601 },
  { kind: "first_pass" },
])("owner range rejects invalid/out-of-source range %j", async (range) => {
  const f = await manualRangeFixture();
  await expect(f.select({ ...f.input, range })).rejects.toBeDefined();
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
it.each([
  { CUT_JOBS_ENABLED: "false" },
  { CUT_REQUESTS_ENABLED: "false" },
  { CAPTURE_JOBS_ENABLED: "false" },
  { CAPTURE_JOBS_GRANT_OPERATIONS: "capture" },
  { CAPTURE_JOBS_GRANT_EPISODE: "127" },
  { CAPTURE_JOBS_GRANT_SOURCE_ID: "other" },
  { CAPTURE_JOBS_GRANT_SHOW: "other" },
  { CAPTURE_JOBS_GRANT_SCOPES: "job:claim" },
  { CAPTURE_JOBS_GRANT_STARTS_AT: new Date(3000).toISOString() },
  { CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(2000).toISOString() },
  { CAPTURE_JOBS_GRANT_EXPIRES_AT: undefined },
  { CAPTURE_JOBS_GRANT_EXPIRES_AT: new Date(86401001).toISOString() },
])("new owner range fails closed for grant/gate %j", async (change) => {
  const f = await manualRangeFixture();
  Object.assign(env, change);
  await expect(f.select()).rejects.toMatchObject({ status: 409 });
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
it.each([
  "UPDATE manual_intake SET revision=2,data=json_set(data,'$.revision',2)",
  "UPDATE manual_intake SET status='cancelled',data=json_set(data,'$.status','cancelled')",
  "UPDATE episode_workspaces SET is_active=0",
  "UPDATE episode_workspaces SET data=json_set(data,'$.number',127)",
  "UPDATE inventory_observations SET item_json=json_set(item_json,'$.media.size_bytes',101)",
  "UPDATE inventory_observations SET item_json=json_set(item_json,'$.media.ref','new-review/other.mp4')",
  "UPDATE inventory_observations SET item_json=json_set(item_json,'$.producer_record.clip_id','other')",
  "UPDATE inventory_observations SET item_json=json_set(item_json,'$.capture_evidence[0].matches_observed_size',json('false'))",
])("owner range rejects superseded or changed source %s", async (sql) => {
  const f = await manualRangeFixture();
  raw.exec(sql);
  await expect(f.select()).rejects.toMatchObject({ status: 409 });
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
it("owner range never competes with already queued planning", async () => {
  const f = await manualRangeFixture();
  await enqueueCut(db, f.input.expectedCutRequestId, "owner", 1000, true);
  await expect(f.select()).rejects.toMatchObject({ status: 409 });
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(1);
});
it("owner range atomic guard rejects an intake edit between validation and commit", async () => {
  const f = await manualRangeFixture();
  const batch = db.batch;
  db.batch = ((statements: D1PreparedStatement[]) => {
    edit();
    return batch(statements);
  }) as typeof db.batch;
  await expect(f.select()).rejects.toMatchObject({ status: 409 });
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(1);
});
it("owner range transaction failure retains original and commits no child or queued job", async () => {
  const f = await manualRangeFixture();
  const batch = db.batch;
  db.batch = ((statements: D1PreparedStatement[]) =>
    batch([
      ...statements,
      new Statement("SELECT missing_column") as unknown as D1PreparedStatement,
    ])) as typeof db.batch;
  await expect(f.select()).rejects.toBeDefined();
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(1);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(1);
});
it("simultaneous identical owner choices create one child; competing choices conflict", async () => {
  const f = await manualRangeFixture();
  const batch = db.batch;
  let pending: Promise<unknown> = Promise.resolve();
  db.batch = ((statements: D1PreparedStatement[]) => {
    const next = pending.then(() => batch(statements));
    pending = next.catch(() => undefined);
    return next;
  }) as typeof db.batch;
  const results = await Promise.all([f.select(), f.select()]);
  expect(results[0]).toEqual(results[1]);
  const choices = await Promise.allSettled([
    f.select(),
    f.select({
      ...f.input,
      range: { kind: "range", startSeconds: 20, endSeconds: 40 },
    }),
  ]);
  expect(choices.map((v) => v.status)).toEqual(["fulfilled", "rejected"]);
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(2);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(2);
});
it("linked owner selection fences a previously validated original enqueue at transaction time", async () => {
  const f = await manualRangeFixture();
  const batch = db.batch;
  let first = true;
  db.batch = (async (statements: D1PreparedStatement[]) => {
    if (first) {
      first = false;
      await f.select();
    }
    return batch(statements);
  }) as typeof db.batch;
  await expect(
    enqueueCut(db, f.input.expectedCutRequestId, "owner", 2000, true),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    raw
      .prepare("SELECT count(*) n FROM capture_jobs WHERE job_id=?")
      .get(f.input.expectedCutRequestId)?.n,
  ).toBe(0);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(2);
});
it("simultaneous distinct first choices cannot both commit", async () => {
  const f = await manualRangeFixture();
  const batch = db.batch;
  let pending: Promise<unknown> = Promise.resolve();
  db.batch = ((statements: D1PreparedStatement[]) => {
    const next = pending.then(() => batch(statements));
    pending = next.catch(() => undefined);
    return next;
  }) as typeof db.batch;
  const choices = await Promise.allSettled([
    f.select(),
    f.select({
      ...f.input,
      range: { kind: "range", startSeconds: 20, endSeconds: 40 },
    }),
  ]);
  expect(choices.filter((v) => v.status === "fulfilled")).toHaveLength(1);
  expect(choices.filter((v) => v.status === "rejected")).toHaveLength(1);
  expect(
    raw.prepare("SELECT count(*) n FROM inventory_cut_requests").get()?.n,
  ).toBe(2);
  expect(raw.prepare("SELECT count(*) n FROM capture_jobs").get()?.n).toBe(2);
});
