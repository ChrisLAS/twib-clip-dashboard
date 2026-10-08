import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { IntakeCreateInput, ManualIntake } from "@twib/shared";
import type { Env } from "../src/env";
import { listIntake, mutateIntake } from "../src/intake";
import { catalogStatus } from "../src/catalog";
import {
  getEpisode,
  getRender,
  listEpisodes,
  mutate,
  operation,
} from "../src/store";
import { seedDemo } from "../src/fixtures";
import worker from "../src/index";

let sqlite: DatabaseSync;
let db: D1Database;
let beforeInsert: (() => void) | undefined;
class Statement {
  values: (string | number | null)[] = [];
  constructor(private sql: string) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (sqlite.prepare(this.sql).get(...this.values) ?? null) as T | null;
  }
  async all<T>() {
    return { results: sqlite.prepare(this.sql).all(...this.values) as T[] };
  }
  async run() {
    if (this.sql.startsWith("INSERT INTO intake_events") && beforeInsert) {
      const hook = beforeInsert;
      beforeInsert = undefined;
      hook();
    }
    return sqlite.prepare(this.sql).run(...this.values);
  }
}
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort())
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  beforeInsert = undefined;
  workspace("draft-workspace", 2, "draft", 1);
  workspace("published-workspace", 1, "published", 0);
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});
function workspace(id: string, number: number, status: string, active: number) {
  sqlite
    .prepare(
      "INSERT INTO episode_workspaces(id,data,status,is_active) VALUES(?,?,?,?)",
    )
    .run(
      id,
      JSON.stringify({
        id,
        number,
        title: `Fictional episode ${number}`,
        subtitle: "Fixture",
        publishedGuid: status === "published" ? "fictional-publication" : null,
      }),
      status,
      active,
    );
}
function input(overrides: Partial<IntakeCreateInput> = {}): IntakeCreateInput {
  return {
    episodeId: "draft-workspace",
    kind: "full_source",
    url: "https://youtu.be/abcdefghijk?si=source-provenance",
    expectedRevision: 0,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}
function count(table: string) {
  return sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
}
function state() {
  return {
    intake: count("manual_intake"),
    events: count("intake_events"),
    operations: count("operations"),
    owners: count("operation_owners"),
    version: sqlite
      .prepare("SELECT intake_version AS v FROM workspace_state")
      .get()?.v,
  };
}
const owner = "owner-one";

describe("separate episode workspaces", () => {
  it("lists active empty draft first, opens it without imported clips, and preserves published status", async () => {
    const episodes = await listEpisodes(db, owner);
    expect(episodes.map((e) => e.id)).toEqual([
      "draft-workspace",
      "published-workspace",
    ]);
    expect(episodes[0]).toMatchObject({
      status: "draft",
      isActive: true,
      clipCount: 0,
      intakeCount: 0,
      uploadFolderUrl: null,
    });
    expect(episodes[1].status).toBe("published");
    expect(await getEpisode(db, "draft-workspace", owner)).toMatchObject({
      clips: [],
      clipCount: 0,
      catalogVersion: 0,
      workspaceVersion: 2,
      intakeVersion: 0,
    });
    expect(count("episodes")).toBe(0);
  });
  it("reads imported fallback without rewriting immutable episode data", async () => {
    const imported = {
      id: "imported",
      number: 5,
      title: "Imported fact",
      subtitle: "Immutable",
      clipCount: 0,
      publishedGuid: "published-guid",
    };
    sqlite
      .prepare("INSERT INTO episodes VALUES(?,?)")
      .run(imported.id, JSON.stringify(imported));
    const original = sqlite
      .prepare("SELECT data FROM episodes WHERE id='imported'")
      .get()?.data;
    expect(
      (await listEpisodes(db, owner)).find((e) => e.id === "imported"),
    ).toMatchObject({
      status: "published",
      isActive: false,
      workspaceRevision: 0,
    });
    workspace("imported", 5, "archived", 0);
    expect((await getEpisode(db, "imported")).status).toBe("archived");
    expect(
      sqlite.prepare("SELECT data FROM episodes WHERE id='imported'").get()
        ?.data,
    ).toBe(original);
  });
  it("isolates workspace clocks and emits only safe configured folder URLs", async () => {
    const before = await catalogStatus({ DB: db } as Env);
    sqlite
      .prepare(
        "UPDATE episode_workspaces SET upload_folder_url=? WHERE id='draft-workspace'",
      )
      .run("https://drive.google.com/drive/folders/fixture-folder");
    expect((await getEpisode(db, "draft-workspace")).uploadFolderUrl).toBe(
      "https://drive.google.com/drive/folders/fixture-folder",
    );
    sqlite
      .prepare(
        "UPDATE episode_workspaces SET upload_folder_url=? WHERE id='draft-workspace'",
      )
      .run("https://evil.example/redirect");
    expect(
      (await getEpisode(db, "draft-workspace")).uploadFolderUrl,
    ).toBeNull();
    const after = await catalogStatus({ DB: db } as Env);
    expect(after.version).toBe(before.version);
    expect(after.workspaceVersion).toBe((before.workspaceVersion ?? 0) + 2);
  });
  it("guards single active draft and rejects archived assignments", async () => {
    expect(() => workspace("second-active", 3, "draft", 1)).toThrow();
    workspace("archived", 0, "archived", 0);
    await expect(
      mutateIntake(db, null, input({ episodeId: "archived" }), owner),
    ).rejects.toMatchObject({ code: "WORKSPACE_ARCHIVED" });
    await expect(
      mutateIntake(db, null, input({ episodeId: "missing" }), owner),
    ).rejects.toMatchObject({ code: "INVALID_EPISODE" });
    expect(state().intake).toBe(0);
  });
});

describe("atomic manual intake records and receipts", () => {
  it("saves provenance awaiting processing with no fake clip, render, fetch or producer event", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("No external fetch allowed");
    });
    vi.stubGlobal("fetch", fetcher);
    const before = await catalogStatus({ DB: db } as Env);
    const request = input();
    const saved = await mutateIntake(db, null, request, owner);
    expect(saved).toMatchObject({
      intakeVersion: 1,
      intake: {
        episodeId: "draft-workspace",
        kind: "full_source",
        status: "awaiting_processing",
        revision: 1,
        submittedUrl: request.url,
        canonicalUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        inMs: null,
        outMs: null,
      },
    });
    expect(await operation(db, request.idempotencyKey, owner)).toMatchObject({
      response: JSON.stringify(saved),
    });
    expect(
      await operation(db, request.idempotencyKey, "someone-else"),
    ).toBeNull();
    expect(await getEpisode(db, "draft-workspace", owner)).toMatchObject({
      clipCount: 0,
      intakeCount: 1,
      clips: [],
    });
    expect((await listIntake(db, owner)).items).toEqual([saved.intake]);
    expect((await listIntake(db, "someone-else")).items).toEqual([]);
    for (const table of [
      "clips",
      "renders",
      "artifacts",
      "producer_events",
      "review_events",
      "imported_manifests",
    ])
      expect(count(table)).toBe(0);
    const after = await catalogStatus({ DB: db } as Env);
    expect(after.version).toBe(before.version);
    expect(after.intakeVersion).toBe(1);
    expect(after.clips).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("supports unassigned, exact retry, changed key content conflict and concurrent same-key receipt", async () => {
    const request = input({
      episodeId: null,
      whyItMatters: "Editorial context",
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => mutateIntake(db, null, request, owner)),
    );
    expect(
      results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(await mutateIntake(db, null, request, owner)).toEqual(results[0]);
    expect(state()).toEqual({
      intake: 1,
      events: 1,
      operations: 1,
      owners: 1,
      version: 1,
    });
    expect((await listIntake(db, owner, null)).items).toHaveLength(1);
    expect((await listIntake(db, owner, "draft-workspace")).items).toHaveLength(
      0,
    );
    await expect(
      mutateIntake(
        db,
        null,
        { ...request, whyItMatters: "Changed content" },
        owner,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
    await expect(
      mutateIntake(db, null, request, "other-owner"),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
  });
  it("rejects source/range duplicate despite alternate provider URL and never silently overwrites provenance", async () => {
    const saved = await mutateIntake(
      db,
      null,
      input({ inMs: 1000, outMs: 2000 }),
      owner,
    );
    await expect(
      mutateIntake(
        db,
        null,
        input({
          url: "https://www.youtube.com/watch?v=abcdefghijk&utm_source=another",
          inMs: 1000,
          outMs: 2000,
          allowDifferentRange: true,
          episodeId: "published-workspace",
        }),
        owner,
      ),
    ).rejects.toMatchObject({
      code: "DUPLICATE_INTAKE",
      duplicateMatches: [
        {
          kind: "intake",
          id: saved.intake.id,
          episodeId: "draft-workspace",
          rangeMatch: "exact",
        },
      ],
    });
    expect((await listIntake(db, owner)).items[0].submittedUrl).toBe(
      saved.intake.submittedUrl,
    );
    expect(state().events).toBe(1);
  });
  it("requires deliberate different-cut consent and preserves each cut's submitted provenance", async () => {
    await mutateIntake(db, null, input({ inMs: 1000, outMs: 2000 }), owner);
    const next = input({
      url: "https://www.youtube.com/watch?v=abcdefghijk&feature=share",
      inMs: 3000,
      outMs: 4000,
    });
    await expect(mutateIntake(db, null, next, owner)).rejects.toMatchObject({
      code: "DUPLICATE_SOURCE",
      duplicateMatches: [{ rangeMatch: "different" }],
    });
    const result = await mutateIntake(
      db,
      null,
      {
        ...next,
        allowDifferentRange: true,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
    expect(result.intake.submittedUrl).toBe(next.url);
    expect(count("manual_intake")).toBe(2);
  });
  it("concurrent duplicate different keys creates only one atomic submission", async () => {
    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, () => mutateIntake(db, null, input(), owner)),
    );
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled
        .filter((result) => result.status === "rejected")
        .every(
          (result) =>
            result.status === "rejected" &&
            result.reason.code === "DUPLICATE_INTAKE",
        ),
    ).toBe(true);
    expect(state()).toEqual({
      intake: 1,
      events: 1,
      operations: 1,
      owners: 1,
      version: 1,
    });
  });
  it("simultaneous different cuts without consent do not evade source warning", async () => {
    const settled = await Promise.allSettled([
      mutateIntake(db, null, input({ inMs: 0, outMs: 1000 }), owner),
      mutateIntake(db, null, input({ inMs: 2000, outMs: 3000 }), owner),
    ]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "DUPLICATE_SOURCE" } });
  });
  it("updates notes/range with optimistic revisions, cancel/restore and immutable provenance", async () => {
    const saved = await mutateIntake(db, null, input(), owner);
    const update = {
      action: "update" as const,
      expectedRevision: 1,
      idempotencyKey: crypto.randomUUID(),
      whyItMatters: "Keep the caveat",
      inMs: 500,
      outMs: 2000,
      episodeId: null,
    };
    const updated = await mutateIntake(db, saved.intake.id, update, owner);
    expect(updated.intake).toMatchObject({
      revision: 2,
      whyItMatters: "Keep the caveat",
      inMs: 500,
      outMs: 2000,
      episodeId: null,
      submittedUrl: saved.intake.submittedUrl,
      createdAt: saved.intake.createdAt,
    });
    await expect(
      mutateIntake(
        db,
        saved.intake.id,
        { ...update, idempotencyKey: crypto.randomUUID() },
        owner,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 2 });
    const cancelled = await mutateIntake(
      db,
      saved.intake.id,
      {
        action: "cancel",
        expectedRevision: 2,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
    expect(cancelled.intake.status).toBe("cancelled");
    await expect(
      mutateIntake(
        db,
        saved.intake.id,
        { ...update, expectedRevision: 3, idempotencyKey: crypto.randomUUID() },
        owner,
      ),
    ).rejects.toMatchObject({ code: "INTAKE_STATE_CONFLICT" });
    const restored = await mutateIntake(
      db,
      saved.intake.id,
      {
        action: "restore",
        expectedRevision: 3,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
    expect(restored.intake).toMatchObject({
      revision: 4,
      status: "awaiting_processing",
      submittedUrl: saved.intake.submittedUrl,
    });
    expect(state()).toEqual({
      intake: 1,
      events: 4,
      operations: 4,
      owners: 4,
      version: 4,
    });
    expect(() => sqlite.exec("DELETE FROM intake_events")).toThrow(/immutable/);
    expect(() => sqlite.exec("UPDATE intake_events SET owner='other'")).toThrow(
      /immutable/,
    );
  });
  it("concurrent updates commit one revision and same-key update races replay once", async () => {
    const created = await mutateIntake(db, null, input(), owner);
    const first = {
      action: "update" as const,
      expectedRevision: 1,
      idempotencyKey: crypto.randomUUID(),
      whyItMatters: "Note A",
    };
    const replayed = await Promise.all([
      mutateIntake(db, created.intake.id, first, owner),
      mutateIntake(db, created.intake.id, first, owner),
    ]);
    expect(replayed[0]).toEqual(replayed[1]);
    const second = {
      action: "update" as const,
      expectedRevision: 2,
      idempotencyKey: crypto.randomUUID(),
      whyItMatters: "Note B",
    };
    const settled = await Promise.allSettled([
      mutateIntake(db, created.intake.id, second, owner),
      mutateIntake(
        db,
        created.intake.id,
        {
          ...second,
          idempotencyKey: crypto.randomUUID(),
          whyItMatters: "Note C",
        },
        owner,
      ),
    ]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: { code: "REVISION_CONFLICT", currentRevision: 3 },
    });
  });
  it("cannot edit another owner's record or claim their operation", async () => {
    const created = await mutateIntake(db, null, input(), owner);
    await expect(
      mutateIntake(
        db,
        created.intake.id,
        {
          action: "cancel",
          expectedRevision: 1,
          idempotencyKey: crypto.randomUUID(),
        },
        "other-owner",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state().events).toBe(1);
  });
  it("cancel is recoverable and restore detects a new exact replacement", async () => {
    const created = await mutateIntake(db, null, input(), owner);
    await mutateIntake(
      db,
      created.intake.id,
      {
        action: "cancel",
        expectedRevision: 1,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
    await mutateIntake(db, null, input(), owner);
    await expect(
      mutateIntake(
        db,
        created.intake.id,
        {
          action: "restore",
          expectedRevision: 2,
          idempotencyKey: crypto.randomUUID(),
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_INTAKE" });
    expect(
      (await listIntake(db, owner)).items.find(
        (i) => i.id === created.intake.id,
      )?.status,
    ).toBe("cancelled");
  });
  it.each([
    { inMs: 10 },
    { outMs: 10 },
    { inMs: 100, outMs: 100 },
    { inMs: 200, outMs: 100 },
    { inMs: -1, outMs: 100 },
    { inMs: 0.5, outMs: 100 },
  ])("rejects invalid range before any write %j", async (range) => {
    await expect(
      mutateIntake(db, null, input(range), owner),
    ).rejects.toBeDefined();
    expect(state().intake).toBe(0);
  });
  it("rolls back event/projection/clock/receipt on a late receipt-key collision", async () => {
    const request = input();
    beforeInsert = () => {
      sqlite
        .prepare("INSERT INTO operations VALUES(?,?,?)")
        .run(request.idempotencyKey, "unrelated-fingerprint", "{}");
    };
    await expect(mutateIntake(db, null, request, owner)).rejects.toMatchObject({
      code: "IDEMPOTENCY_REUSE",
    });
    expect(state()).toEqual({
      intake: 0,
      events: 0,
      operations: 1,
      owners: 0,
      version: 0,
    });
  });
  it("fences concurrent imported-catalog change without partial intake writes", async () => {
    beforeInsert = () =>
      sqlite.exec("UPDATE sync_state SET version=version+1 WHERE id=1");
    await expect(mutateIntake(db, null, input(), owner)).rejects.toMatchObject({
      code: "CATALOG_CONFLICT",
    });
    expect(state()).toEqual({
      intake: 0,
      events: 0,
      operations: 0,
      owners: 0,
      version: 0,
    });
  });
  it("guards workspace archival inside SQL commit", async () => {
    beforeInsert = () =>
      sqlite.exec(
        "UPDATE episode_workspaces SET status='archived',is_active=0 WHERE id='draft-workspace'",
      );
    await expect(mutateIntake(db, null, input(), owner)).rejects.toMatchObject({
      code: "WORKSPACE_ARCHIVED",
    });
    expect(state().intake).toBe(0);
  });
  it("SQL owner/revision guards and invalid projection roll back even bypassing preflight", async () => {
    const created = await mutateIntake(db, null, input(), owner);
    const original = state();
    const data = {
      ...created.intake,
      revision: 2,
      whyItMatters: "unauthorized",
    };
    const insert = (who: string, revision: number, record: ManualIntake) =>
      sqlite
        .prepare("INSERT INTO intake_events VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          crypto.randomUUID(),
          crypto.randomUUID(),
          created.intake.id,
          who,
          "update",
          revision,
          0,
          0,
          JSON.stringify(record),
          "fixture-fingerprint",
        );
    expect(() => insert("other-owner", 1, data)).toThrow(/owner conflict/);
    expect(() => insert(owner, 0, { ...data, revision: 1 })).toThrow(
      /revision/,
    );
    expect(() =>
      insert(owner, 1, {
        ...data,
        canonicalUrl: "https://other.example/video",
      }),
    ).toThrow(/provenance/);
    expect(() =>
      insert(owner, 1, { ...data, inMs: 200, outMs: 100 }),
    ).toThrow();
    expect(state()).toEqual(original);
  });
  it("checks imported source ranges without changing clip, render or existing review", async () => {
    sqlite.exec("UPDATE episode_workspaces SET is_active=0");
    await seedDemo(db);
    const source = "https://www.youtube.com/watch?v=abcdefghijk&feature=share";
    sqlite
      .prepare(
        "UPDATE renders SET data=json_set(data,'$.source.url',?,'$.source.inMs',1000,'$.source.outMs',2000) WHERE id='render-topic-one-v1'",
      )
      .run(source);
    await mutate(
      db,
      "review",
      "render-topic-one-v1",
      {
        decision: "up",
        expectedRevision: 0,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
    const review = await getRender(db, "render-topic-one-v1");
    await expect(
      mutateIntake(db, null, input({ inMs: 1000, outMs: 2000 }), owner),
    ).rejects.toMatchObject({
      code: "DUPLICATE_INTAKE",
      duplicateMatches: [
        {
          kind: "render",
          id: "render-topic-one-v1",
          episodeId: "ep-demo",
          rangeMatch: "exact",
        },
      ],
    });
    await expect(
      mutateIntake(db, null, input({ inMs: 3000, outMs: 4000 }), owner),
    ).rejects.toMatchObject({ code: "DUPLICATE_SOURCE" });
    await mutateIntake(
      db,
      null,
      input({ inMs: 3000, outMs: 4000, allowDifferentRange: true }),
      owner,
    );
    expect(await getRender(db, "render-topic-one-v1")).toEqual(review);
    expect(count("clips")).toBe(5);
    expect(count("renders")).toBe(5);
    expect(count("review_events")).toBe(1);
  });
});

describe("authenticated intake HTTP routes", () => {
  let env: Env;
  beforeEach(() => {
    sqlite.exec("UPDATE episode_workspaces SET is_active=0");
    env = {
      DB: db,
      APP_ENV: "local",
      LOCAL_DEMO: "true",
      APP_ORIGIN: "http://localhost",
    };
  });
  async function post(path: string, payload: unknown, token?: string) {
    return worker.fetch(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
          ...(token ? { "X-CSRF-Token": token } : {}),
        },
        body: JSON.stringify(payload),
      }),
      env,
    );
  }
  it("requires mutation CSRF, emits duplicate targets, supports receipt reconciliation and never fetches URLs", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("No fetch");
    });
    vi.stubGlobal("fetch", fetcher);
    const session = (await (
      await worker.fetch(new Request("http://localhost/api/session"), env)
    ).json()) as {
      csrfToken: string;
      integrations: { intakeProducer: boolean };
    };
    expect(session.integrations.intakeProducer).toBe(false);
    expect((await post("/api/intake", input())).status).toBe(403);
    const request = input();
    const response = await post("/api/intake", request, session.csrfToken);
    expect(response.status).toBe(200);
    const saved = (await response.json()) as { intake: ManualIntake };
    const duplicate = await post("/api/intake", input(), session.csrfToken);
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({
      error: { code: "DUPLICATE_INTAKE" },
      existingIntakeIds: [saved.intake.id],
      duplicateMatches: [{ kind: "intake", id: saved.intake.id }],
    });
    const receipt = await worker.fetch(
      new Request(`http://localhost/api/operations/${request.idempotencyKey}`),
      env,
    );
    expect(await receipt.json()).toEqual(saved);
    const list = await worker.fetch(
      new Request("http://localhost/api/intake?episodeId=draft-workspace"),
      env,
    );
    expect(await list.json()).toMatchObject({
      version: 1,
      items: [{ id: saved.intake.id }],
    });
    const update = await post(
      `/api/intake/${saved.intake.id}`,
      {
        action: "cancel",
        expectedRevision: 1,
        idempotencyKey: crypto.randomUUID(),
      },
      session.csrfToken,
    );
    expect(update.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects unsafe URL, unexpected fields, invalid action fields and absent owner session", async () => {
    const session = (await (
      await worker.fetch(new Request("http://localhost/api/session"), env)
    ).json()) as { csrfToken: string };
    expect(
      (
        await post(
          "/api/intake",
          input({ url: "http://127.0.0.1/private" }),
          session.csrfToken,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          "/api/intake",
          { ...input(), fetch: true },
          session.csrfToken,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          "/api/intake/missing",
          {
            action: "cancel",
            expectedRevision: 1,
            idempotencyKey: crypto.randomUUID(),
            whyItMatters: "hidden edit",
          },
          session.csrfToken,
        )
      ).status,
    ).toBe(422);
    const locked = {
      ...env,
      APP_ENV: "production",
      LOCAL_DEMO: undefined,
      APP_ORIGIN: "https://review.example",
      ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
      ACCESS_AUD: "fixture",
      OWNER_EMAIL: "fixture@example.com",
    };
    expect(
      (
        await worker.fetch(
          new Request("https://review.example/api/intake"),
          locked,
        )
      ).status,
    ).toBe(401);
    expect(state().intake).toBe(0);
  });
});
