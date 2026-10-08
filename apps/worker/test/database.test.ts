import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { seedDemo } from "../src/fixtures";
import {
  getEpisode,
  getRender,
  mutate,
  events,
  projectProduction,
} from "../src/store";
import { importManifest, manifestSchema } from "../src/importer";
import type { Env } from "../src/env";
import type { ProducerEvent } from "@twib/shared";
class Statement {
  values: (string | number | null)[] = [];
  constructor(
    private sqlite: DatabaseSync,
    private sql: string,
  ) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.values) ??
      null) as T | null;
  }
  async all<T>() {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.values) as T[],
    };
  }
  async run() {
    return this.sqlite.prepare(this.sql).run(...this.values);
  }
}
let sqlite: DatabaseSync;
let db: D1Database;
let env: Env;
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0002_import_receipts.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0003_catalog_sync.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL(
        "../migrations/0004_episode_workspaces_intake.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
  env = { DB: db, APP_ENV: "local", ALLOWED_EPISODE_IDS: "ep-demo" };
  await seedDemo(db);
});
describe("real SQLite event transactions", () => {
  it("commits review and projection once across retry; conflicts and changed key rejected", async () => {
    const input = {
      decision: "up" as const,
      note: "Useful qualification",
      expectedRevision: 0,
      idempotencyKey: "request-123",
    };
    const a = await mutate(db, "review", "render-topic-one-v1", input, "owner");
    expect(
      await mutate(db, "review", "render-topic-one-v1", input, "owner"),
    ).toEqual(a);
    expect((await getRender(db, "render-topic-one-v1")).review.revision).toBe(
      1,
    );
    await expect(
      mutate(
        db,
        "review",
        "render-topic-one-v1",
        { ...input, idempotencyKey: "request-456" },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 1 });
    await expect(
      mutate(
        db,
        "review",
        "render-topic-one-v1",
        { ...input, decision: "down" },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REUSE" });
    expect(
      sqlite.prepare("SELECT count(*) n FROM review_events").get()?.n,
    ).toBe(1);
  });
  it("Hide/Restore are independent of reviews and media", async () => {
    await mutate(
      db,
      "visibility",
      "clip-topic-one",
      {
        visibility: "hidden",
        expectedRevision: 0,
        idempotencyKey: "hide-1234",
      },
      "owner",
    );
    expect(
      (await getEpisode(db, "ep-demo")).clips[0].visibility,
    ).not.toBeUndefined();
    expect((await getRender(db, "render-topic-one-v1")).review.decision).toBe(
      "clear",
    );
    await mutate(
      db,
      "visibility",
      "clip-topic-one",
      {
        visibility: "visible",
        expectedRevision: 1,
        idempotencyKey: "restore-1234",
      },
      "owner",
    );
    expect(
      sqlite
        .prepare("SELECT visibility,revision FROM clips WHERE id=?")
        .get("clip-topic-one"),
    ).toMatchObject({ visibility: "visible", revision: 2 });
  });
  it("rolls back event when projection insertion fails", async () => {
    sqlite.exec(
      "CREATE TRIGGER reject_operation BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'failure'); END;",
    );
    await expect(
      mutate(
        db,
        "review",
        "render-topic-one-v1",
        { decision: "up", expectedRevision: 0, idempotencyKey: "failure-123" },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "SAVE_FAILED" });
    expect((await getRender(db, "render-topic-one-v1")).review.revision).toBe(
      0,
    );
    expect(
      sqlite.prepare("SELECT count(*) n FROM review_events").get()?.n,
    ).toBe(0);
  });
  it("retains old attempt events without regressing active state and deduplicates import", async () => {
    const e: ProducerEvent = {
      schemaVersion: 1,
      id: "new-event",
      attemptId: "new-attempt",
      clipId: "clip-topic-three",
      sequence: 1,
      occurredAt: "2026-10-07T12:05:00Z",
      state: "working",
      stage: "New cut",
      progress: true,
      nextExpectedAt: "2026-10-07T12:10:00Z",
      blocker: null,
      checkpoint: "cut-plan",
    };
    const manifest = {
      schemaVersion: 1 as const,
      episodes: [],
      clips: [],
      renders: [],
      artifacts: [],
      events: [e],
      activations: [
        {
          clipId: e.clipId,
          attemptId: e.attemptId,
          supersedes: "attempt-topic-three-1",
        },
      ],
    };
    await importManifest(env, manifest, "unused");
    await importManifest(env, manifest, "unused");
    const slate = await getEpisode(db, "ep-demo");
    expect(slate.clips.find((c) => c.id === e.clipId)?.production.stage).toBe(
      "New cut",
    );
    expect(await events(db, e.attemptId)).toHaveLength(1);
    expect(
      projectProduction(
        [{ ...e, attemptId: "old", sequence: 999 }],
        e.attemptId,
      ).state,
    ).toBe("unknown");
  });
  it("rejects duplicate manifest events and cross-clip attempt ownership", async () => {
    const e = (await events(db))[0];
    const base = {
      schemaVersion: 1 as const,
      episodes: [],
      clips: [],
      renders: [],
      artifacts: [],
      events: [e, e],
      activations: [],
    };
    await expect(importManifest(env, base, "unused")).rejects.toMatchObject({
      code: "DUPLICATE_MANIFEST_KEY",
    });
    await expect(
      importManifest(
        env,
        {
          ...base,
          events: [
            {
              ...e,
              id: "different-event",
              sequence: 2,
              clipId: "clip-topic-one",
            },
          ],
        },
        "unused",
      ),
    ).rejects.toMatchObject({ code: "ATTEMPT_OWNERSHIP" });
  });
  it("rejects script URLs and invalid timeline ranges at import boundary", () => {
    expect(
      manifestSchema.safeParse({
        schemaVersion: 1,
        episodes: [],
        clips: [],
        renders: [{ id: "r" }],
        artifacts: [],
        events: [],
        activations: [],
      }).success,
    ).toBe(false);
  });
});

describe("Worker route integration with real SQLite", () => {
  it("loads fictional slate, saves once, reconciles, and hides without deleting", async () => {
    const worker = (await import("../src/index")).default;
    const local = {
      ...env,
      LOCAL_DEMO: "true",
      APP_ORIGIN: "http://localhost:5173",
    };
    const response = await worker.fetch(
      new Request("http://localhost:8787/api/session"),
      local,
    );
    expect(response.status).toBe(200);
    const session = (await response.json()) as { csrfToken: string };
    const request = () =>
      new Request(
        "http://localhost:8787/api/renders/render-topic-one-v1/reviews",
        {
          method: "POST",
          headers: {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrfToken,
          },
          body: JSON.stringify({
            decision: "defer",
            note: "Save for another episode",
            expectedRevision: 0,
            idempotencyKey: "route-request-1",
          }),
        },
      );
    const saved = await worker.fetch(request(), local);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      decision: "defer",
      revision: 1,
    });
    expect((await worker.fetch(request(), local)).status).toBe(200);
    const reconciliation = await worker.fetch(
      new Request("http://localhost:8787/api/operations/route-request-1"),
      local,
    );
    expect(await reconciliation.json()).toMatchObject({
      decision: "defer",
      revision: 1,
    });
    const slate = await worker.fetch(
      new Request("http://localhost:8787/api/episodes/ep-demo"),
      local,
    );
    expect(slate.status).toBe(200);
    expect(((await slate.json()) as { clips: unknown[] }).clips).toHaveLength(
      5,
    );
  });
  it("fails closed for production assets/API/media despite spoofed demo headers", async () => {
    const worker = (await import("../src/index")).default;
    for (const path of [
      "/",
      "/api/episodes",
      "/media/render-topic-one-v1/original",
    ]) {
      const response = await worker.fetch(
        new Request(`https://public.invalid${path}`, {
          headers: {
            "X-Demo": "true",
            "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
          },
        }),
        { ...env, APP_ENV: "production", LOCAL_DEMO: "true" },
      );
      expect(response.status).toBe(503);
    }
  });
});

describe("immutable manifest version progression", () => {
  it("advances renders, starts unreviewed and skips old accepted manifest replays", async () => {
    const original = await getRender(db, "render-topic-one-v1");
    await mutate(
      db,
      "review",
      original.id,
      {
        decision: "up",
        expectedRevision: 0,
        idempotencyKey: "review-old-render",
      },
      "owner",
    );
    const manifest = (version: number) => ({
      schemaVersion: 1 as const,
      episodes: [],
      clips: [
        {
          id: original.clipId,
          episodeId: "ep-demo",
          title: "The opening argument",
          summary:
            "Review the argument and its surrounding qualifications before an editorial decision.",
          narrativeRole: "establish",
          currentRenderId: `render-topic-one-v${version}`,
          renderIds: Array.from(
            { length: version },
            (_, i) => `render-topic-one-v${i + 1}`,
          ),
        },
      ],
      renders: [
        {
          id: `render-topic-one-v${version}`,
          clipId: original.clipId,
          version,
          title: original.title,
          durationMs: original.durationMs,
          createdAt: original.createdAt,
          recipeHash: `recipe-v${version}`,
          artifactHash: null,
          source: original.source,
          mappingVerified: false,
          cues: [],
          qa: [],
        },
      ],
      artifacts: [],
      events: [],
      activations: [],
    });
    const second = manifest(2);
    await importManifest(env, second, "unused");
    await importManifest(env, manifest(3), "unused");
    await importManifest(env, second, "unused");
    const clip = (await getEpisode(db, "ep-demo")).clips.find(
      (c) => c.id === original.clipId,
    )!;
    expect(clip.currentRenderId).toBe("render-topic-one-v3");
    expect(clip.render.review.decision).toBe("clear");
    expect(clip.render.review.revision).toBe(0);
    expect((await getRender(db, original.id)).review.decision).toBe("up");
  });
});
