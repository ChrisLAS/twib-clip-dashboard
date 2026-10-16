import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  createJob,
  claimJob,
  acceptResult,
  retryJob,
} from "../src/capture-jobs/store";
import { createJobSchema } from "../src/capture-jobs/contract";
import worker from "../src/index";
import type { Env } from "../src/env";
class Statement {
  values: (string | number | null)[] = [];
  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {}
  bind(...v: (string | number | null)[]) {
    this.values = v;
    return this;
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }
  async run() {
    return this.db.prepare(this.sql).run(...this.values);
  }
}
let db: D1Database;
let raw: DatabaseSync;
afterEach(() => raw.close());
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = {
  job_id: id(1),
  show: "twib",
  episode: 127,
  url: "https://www.youtube.com/watch?v=abcdefghijk",
  reported_by: "chad",
};
beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  raw = sqlite;
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0012_capture_jobs.sql", import.meta.url),
      "utf8",
    ),
  );
  db = {
    prepare: (s: string) => new Statement(sqlite, s),
    batch: async (ss: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of ss) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
});
it("immutable creation rejects changed source/identity, no arbitrary paths", async () => {
  await createJob(db, input, "owner", 0);
  await createJob(db, input, "owner", 0);
  await expect(
    createJob(db, { ...input, url: "https://vimeo.com/123" }, "owner"),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
  for (const bad of [
    { ...input, path: "/tmp/a" },
    { ...input, episode: 0 },
    { ...input, url: "http://127.0.0.1/a" },
    { ...input, url: "https://youtube.com.evil/watch?v=abcdefghijk" },
  ])
    expect(createJobSchema.safeParse(bad).success).toBe(false);
});
it("claim replay stable; expired capture never redispatches", async () => {
  await createJob(db, input, "owner", 0);
  const a = await claimJob(db, { request_id: id(2) }, 100);
  expect(a.claim?.executor).toBe("nomad:capture-worker");
  expect(a.claim).toHaveProperty("retry_id", null);
  expect(await claimJob(db, { request_id: id(2) }, 99999999)).toEqual(a);
  expect((await claimJob(db, { request_id: id(3) }, 7200200)).claim).toBeNull();
  expect(
    (
      await db
        .prepare("SELECT state FROM capture_jobs")
        .first<{ state: string }>()
    )?.state,
  ).toBe("needs_review");
});
it("current lease accepts late terminal, immutable delivery replays and conflicts", async () => {
  await createJob(db, input, "owner", 0);
  await claimJob(db, { request_id: id(2) }, 1);
  await claimJob(db, { request_id: id(3) }, 8000000);
  const result = {
    delivery_id: id(4),
    job_id: id(1),
    lease_id: id(2),
    state: "succeeded",
    attempt: 1,
    code: null,
  };
  const a = await acceptResult(db, result, 8000000);
  expect(await acceptResult(db, result, 9000000)).toEqual(a);
  await expect(
    acceptResult(db, { ...result, state: "needs_review" }),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
});
it("explicit retry invalidates old lease and is idempotent", async () => {
  await createJob(db, input, "owner", 0);
  await claimJob(db, { request_id: id(2) }, 1);
  await retryJob(db, id(1), { retry_id: id(5) }, 8000000);
  await retryJob(db, id(1), { retry_id: id(5) }, 8000001);
  await expect(
    acceptResult(db, {
      delivery_id: id(4),
      job_id: id(1),
      lease_id: id(2),
      state: "succeeded",
      attempt: 1,
      code: null,
    }),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
  const claim = (await claimJob(db, { request_id: id(6) }, 8000002)).claim;
  expect(claim?.operation).toBe("retry");
  expect(claim?.retry_id).toBe(id(5));
});
it("disabled machine and owner paths reject before auth/body/db", async () => {
  const env = { APP_ENV: "local" } as Env;
  for (const path of [
    "/api/v1/capture-jobs/claim",
    "/api/v1/capture-jobs/result",
    "/api/capture-jobs",
  ]) {
    const response = await worker.fetch(
      new Request(`https://test.invalid${path}`, {
        method: "POST",
        body: "malformed",
      }),
      env,
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).toContain(
      "CAPTURE_JOBS_DISABLED",
    );
  }
});
it("inventory grant cannot activate job authentication", async () => {
  const env = {
    APP_ENV: "local",
    CAPTURE_JOBS_ENABLED: "true",
    INVENTORY_ACCESS_AUD: "a".repeat(64),
  } as Env;
  const response = await worker.fetch(
    new Request("https://test.invalid/api/v1/capture-jobs/claim", {
      method: "POST",
      body: "{}",
    }),
    env,
  );
  expect(response.status).toBe(503);
});
it("null claim remains immutable after new work arrives", async () => {
  const empty = await claimJob(db, { request_id: id(8) }, 0);
  expect(empty.claim).toBeNull();
  await createJob(db, input, "owner", 1);
  expect(await claimJob(db, { request_id: id(8) }, 2)).toEqual(empty);
  expect((await claimJob(db, { request_id: id(9) }, 3)).claim?.job_id).toBe(
    id(1),
  );
});
it("rejects expired running updates and attempt rollback", async () => {
  await createJob(db, input, "owner", 0);
  await claimJob(db, { request_id: id(2) }, 1);
  await expect(
    acceptResult(
      db,
      {
        delivery_id: id(4),
        job_id: id(1),
        lease_id: id(2),
        state: "running",
        attempt: 1,
        code: null,
      },
      8000000,
    ),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
  await acceptResult(
    db,
    {
      delivery_id: id(4),
      job_id: id(1),
      lease_id: id(2),
      state: "running",
      attempt: 2,
      code: null,
    },
    2,
  );
  await expect(
    acceptResult(
      db,
      {
        delivery_id: id(5),
        job_id: id(1),
        lease_id: id(2),
        state: "succeeded",
        attempt: 1,
        code: null,
      },
      3,
    ),
  ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
});
it("bounds claim history without destroying old replay receipts", async () => {
  for (let n = 0; n < 10000; n++)
    await db
      .prepare(
        "INSERT INTO capture_job_claims(request_id,response_json) VALUES(?,?)",
      )
      .bind(id(n + 100), "{}")
      .run();
  await expect(claimJob(db, { request_id: id(2) }, 0)).rejects.toMatchObject({
    code: "JOB_CAPACITY",
    status: 429,
  });
  expect(await claimJob(db, { request_id: id(100) }, 0)).toEqual({});
});

it.each([
  "https://youtu.be/abcdefghijk?token=private",
  "https://vimeo.com/123?token=private",
  "https://x.com/user/status/123?secret=private",
  "https://youtube.com/watch?v=abcdefghijk&secret=private",
  "https://youtube.com/watch?v=abcdefghijk&v=abcdefghijk",
  "https://youtube.com/watch?%76=abcdefghijk",
  "https://youtube.com/else/../watch?v=abcdefghijk",
  "https://youtu.be/abcdefghijk#private",
  "https://user:password@youtu.be/abcdefghijk",
  "https://youtu.be/abcdefghijk\n",
  "https:\\youtu.be\\abcdefghijk",
  "https://x.com/abcdefghijklmnop/status/123",
  "https://vimeo.com/" + "1".repeat(21),
])(
  "rejects private or normalized source URL %s before persistence",
  async (url) => {
    expect(createJobSchema.safeParse({ ...input, url }).success).toBe(false);
    await expect(
      createJob(db, { ...input, url }, "owner"),
    ).rejects.toBeTruthy();
    expect(raw.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n).toBe(
      0,
    );
  },
);
it.each([
  "https://youtube.com/watch?v=abcdefghijk",
  "https://m.youtube.com/shorts/abcdefghijk",
  "https://www.youtube.com/live/abcdefghijk",
  "https://youtu.be/abcdefghijk",
  "https://vimeo.com/123",
  "https://twitter.com/user/status/123",
])("accepts only supported public source shape %s", (url) => {
  expect(createJobSchema.safeParse({ ...input, url }).success).toBe(true);
});
it("SQL capacity triggers reject direct inserts and retain all stored history", () => {
  raw.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000) INSERT INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) SELECT 'job-'||n,'{}','owner','queued','capture',0,0 FROM seq",
  );
  expect(() =>
    raw.exec(
      "INSERT INTO capture_jobs(job_id,request_json,owner,state,operation,created_at,updated_at) VALUES('overflow','{}','owner','queued','capture',0,0)",
    ),
  ).toThrow("JOB_CAPACITY");
  raw.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10000) INSERT INTO capture_job_claims SELECT 'claim-'||n,'{}' FROM seq",
  );
  expect(() =>
    raw.exec("INSERT INTO capture_job_claims VALUES('overflow','{}')"),
  ).toThrow("JOB_CAPACITY");
  raw.exec(
    "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<50000) INSERT INTO capture_job_deliveries SELECT 'delivery-'||n,'{}','{}' FROM seq",
  );
  expect(() =>
    raw.exec("INSERT INTO capture_job_deliveries VALUES('overflow','{}','{}')"),
  ).toThrow("JOB_CAPACITY");
  expect(raw.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n).toBe(
    1000,
  );
  expect(
    raw.prepare("SELECT count(*) AS n FROM capture_job_claims").get()?.n,
  ).toBe(10000);
  expect(
    raw.prepare("SELECT count(*) AS n FROM capture_job_deliveries").get()?.n,
  ).toBe(50000);
});
it("demo cannot operate jobs even when the configuration flag is enabled", async () => {
  const response = await worker.fetch(
    new Request("http://localhost/api/capture-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    {
      APP_ENV: "local",
      LOCAL_DEMO: "true",
      CAPTURE_JOBS_ENABLED: "true",
      DB: db,
    } as Env,
  );
  expect(response.status).toBe(403);
  expect(raw.prepare("SELECT count(*) AS n FROM capture_jobs").get()?.n).toBe(
    0,
  );
});

it("needs-review cannot return to runnable states without an explicit retry", async () => {
  await createJob(db, input, "owner", 0);
  await claimJob(db, { request_id: id(2) }, 1);
  await acceptResult(
    db,
    {
      delivery_id: id(3),
      job_id: id(1),
      lease_id: id(2),
      state: "needs_review",
      attempt: 1,
      code: null,
    },
    2,
  );
  for (const state of ["blocked", "waiting_for_episode", "running"])
    await expect(
      acceptResult(
        db,
        {
          delivery_id: id(4),
          job_id: id(1),
          lease_id: id(2),
          state,
          attempt: 1,
          code: null,
        },
        3,
      ),
    ).rejects.toMatchObject({ code: "JOB_CONFLICT" });
  await acceptResult(
    db,
    {
      delivery_id: id(5),
      job_id: id(1),
      lease_id: id(2),
      state: "succeeded",
      attempt: 1,
      code: null,
    },
    4,
  );
  expect(raw.prepare("SELECT state FROM capture_jobs").get()?.state).toBe(
    "succeeded",
  );
});
it("identical delivery committed between receipt and state reads returns its durable acknowledgment", async () => {
  await createJob(db, input, "owner", 0);
  await claimJob(db, { request_id: id(2) }, 1);
  const payload = {
    delivery_id: id(44),
    job_id: id(1),
    lease_id: id(2),
    state: "succeeded",
    attempt: 1,
    code: null,
  };
  const base = db;
  let missed = false,
    committed = false;
  const racing = {
    prepare(sql: string) {
      let statement = base.prepare(sql);
      const wrapper = {
        bind(...values: (string | number | null)[]) {
          statement = statement.bind(...values);
          return wrapper;
        },
        async first<T>() {
          if (
            sql.startsWith(
              "SELECT request_json,response_json FROM capture_job_deliveries",
            ) &&
            !missed
          ) {
            missed = true;
            return null;
          }
          if (sql.startsWith("SELECT * FROM capture_jobs") && !committed) {
            committed = true;
            await acceptResult(base, payload, 2);
          }
          return statement.first<T>();
        },
        all: () => statement.all(),
        run: () => statement.run(),
      };
      return wrapper;
    },
    batch: base.batch.bind(base),
  } as unknown as D1Database;
  const result = await acceptResult(racing, payload, 3);
  expect(result).toEqual(await acceptResult(base, payload, 4));
  expect(missed && committed).toBe(true);
  expect(
    raw.prepare("SELECT count(*) AS n FROM capture_job_deliveries").get()?.n,
  ).toBe(1);
});
