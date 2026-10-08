import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import {
  acquireSyncLease,
  catalogStatus,
  readBoundedText,
  SYNC_DEADLINE_MS,
} from "../src/catalog";
import { importManifest, manifestSchema, pullManifest } from "../src/importer";
import { getEpisode, getRender, mutate, listEpisodes } from "../src/store";
import worker from "../src/index";
import type { Env } from "../src/env";

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
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort())
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  env = {
    DB: db,
    APP_ENV: "production",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh",
    PRODUCER_SHEET_ID: "test-sheet",
    PRODUCER_SHEET_RANGE: "Manifests!A2:A101",
    ALLOWED_EPISODE_IDS: "test-episode",
    ALLOWED_DRIVE_FOLDER_IDS: "test-folder",
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sqlite.close();
});
function manifest(version = 1) {
  return manifestSchema.parse({
    schemaVersion: 1,
    episodes: [
      {
        id: "test-episode",
        number: 1,
        title: "Fictional episode",
        subtitle: "Fixture",
        clipCount: 0,
        publishedGuid: null,
      },
    ],
    clips: [
      {
        id: "test-clip",
        episodeId: "test-episode",
        title: "Fictional clip",
        summary: "Fixture",
        narrativeRole: "example",
        currentRenderId: `test-render-${version}`,
        renderIds: Array.from(
          { length: version },
          (_, i) => `test-render-${i + 1}`,
        ),
      },
    ],
    renders: [
      {
        id: `test-render-${version}`,
        clipId: "test-clip",
        version,
        title: "Fictional clip",
        durationMs: 1000,
        createdAt: "2026-10-07T00:00:00Z",
        recipeHash: `recipe-${version}`,
        artifactHash: "a".repeat(64),
        source: {
          title: "Fixture",
          speaker: "Fixture",
          url: null,
          edition: "Fixture",
          recordingDate: null,
          publicationDate: null,
          retrievedAt: null,
          inMs: 0,
          outMs: 1000,
          context: "Fixture",
        },
        mappingVerified: false,
        cues: [],
        qa: [],
      },
    ],
    artifacts: [
      {
        renderId: `test-render-${version}`,
        kind: "original",
        fileId: `test-file-${version}`,
        size: 1,
        sha256: "a".repeat(64),
      },
    ],
    events: [],
    activations: [],
  });
}
function google(rows: unknown[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com"))
      return Response.json({ access_token: "test-token" });
    if (url.includes("sheets.googleapis.com"))
      return Response.json({
        values: rows.map((row) => [
          typeof row === "string" ? row : JSON.stringify(row),
        ]),
      });
    if (url.includes("www.googleapis.com/drive/"))
      return Response.json({
        parents: ["test-folder"],
        size: "1",
        mimeType: "video/mp4",
        sha256Checksum: "a".repeat(64),
        capabilities: { canDownload: true },
      });
    throw new Error("Unexpected URL");
  });
}
const count = (table: string) =>
  Number(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);

describe("automatic catalog sync", () => {
  it("imports atomically and keeps unchanged runs cheap and revision-stable", async () => {
    const fetcher = google([manifest()]);
    expect(await pullManifest(env, fetcher)).toMatchObject({ imported: 1 });
    const initial = await catalogStatus(env);
    expect(initial).toMatchObject({
      complete: true,
      sync: { configured: true, running: false, stale: false, lastError: null },
    });
    expect(initial.clips).toHaveLength(1);
    fetcher.mockClear();
    expect(await pullManifest(env, fetcher)).toEqual({
      imported: 0,
      skipped: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2); // OAuth + Sheet only, no media.
    expect((await catalogStatus(env)).version).toBe(initial.version);
    expect(count("imported_manifests")).toBe(1);
    expect(count("imported_sheet_rows")).toBe(1);
    expect(
      (await getEpisode(db, "test-episode")).clips[0].catalogRevision,
    ).toBe(initial.clips[0].revision);
    expect((await listEpisodes(db))[0].clipCount).toBe(1);
  });
  it("uses raw row receipts when the Sheet changes and preserves review/visibility on a new render", async () => {
    await pullManifest(env, google([manifest()]));
    await mutate(
      db,
      "review",
      "test-render-1",
      {
        decision: "up",
        note: "Keep this note",
        expectedRevision: 0,
        idempotencyKey: "test-review",
      },
      "owner",
    );
    await mutate(
      db,
      "visibility",
      "test-clip",
      {
        visibility: "hidden",
        expectedRevision: 0,
        idempotencyKey: "test-hide",
      },
      "owner",
    );
    const before = await catalogStatus(env);
    const nextFetch = google([manifest(), manifest(2)]);
    expect(await pullManifest(env, nextFetch)).toEqual({
      imported: 1,
      skipped: 1,
    });
    expect(nextFetch).toHaveBeenCalledTimes(3);
    const clip = (await getEpisode(db, "test-episode")).clips[0];
    expect(clip).toMatchObject({
      currentRenderId: "test-render-2",
      visibility: "hidden",
      visibilityRevision: 1,
    });
    expect(clip.render.review).toMatchObject({
      revision: 0,
      decision: "clear",
      note: "",
    });
    expect((await getRender(db, "test-render-1")).review).toMatchObject({
      decision: "up",
      note: "Keep this note",
      revision: 1,
    });
    expect(clip.catalogRevision).toBeGreaterThan(before.clips[0].revision);
  });
  it("does not count review/visibility changes as producer catalog updates", async () => {
    await pullManifest(env, google([manifest()]));
    const before = await catalogStatus(env);
    await mutate(
      db,
      "review",
      "test-render-1",
      {
        decision: "defer",
        expectedRevision: 0,
        idempotencyKey: "review-no-catalog",
      },
      "owner",
    );
    await mutate(
      db,
      "visibility",
      "test-clip",
      {
        visibility: "hidden",
        expectedRevision: 0,
        idempotencyKey: "hide-no-catalog",
      },
      "owner",
    );
    const after = await catalogStatus(env);
    expect(after.version).toBe(before.version);
    expect(after.clips).toEqual(before.clips);
  });
  it("rejects changed same-ID clip metadata visibly without committing a receipt", async () => {
    await pullManifest(env, google([manifest()]));
    const before = await catalogStatus(env);
    const edited = manifest();
    edited.clips[0].title = "Edited immutable title";
    await expect(pullManifest(env, google([edited]))).rejects.toMatchObject({
      code: "IMMUTABLE_CONFLICT",
    });
    expect((await catalogStatus(env)).version).toBe(before.version);
    expect((await catalogStatus(env)).sync).toMatchObject({
      running: false,
      lastSuccessAt: before.sync.lastSuccessAt,
    });
    expect((await catalogStatus(env)).sync.lastError).toContain(
      "metadata changed",
    );
    expect(count("imported_manifests")).toBe(1);
    expect(count("imported_sheet_rows")).toBe(1);
    expect((await getEpisode(db, "test-episode")).clips[0].title).toBe(
      "Fictional clip",
    );
  });
  it("excludes overlapping manual/cron pulls before OAuth or Sheet fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordinary = google([]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      return ordinary(input);
    });
    const first = pullManifest(env, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect((await catalogStatus(env)).sync.running).toBe(true);
    await expect(pullManifest(env, fetcher)).rejects.toMatchObject({
      code: "SYNC_IN_PROGRESS",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("fences expired commits and prevents a stale owner's cleanup from erasing its successor", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ordinary = google([manifest()]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      await gate;
      return ordinary(input);
    });
    const oldRun = pullManifest(env, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const oldOwner = String(
      sqlite.prepare("SELECT lease_owner FROM sync_state").get()?.lease_owner,
    );
    sqlite.exec("UPDATE sync_state SET lease_expires_at=0");
    const next = await acquireSyncLease(db);
    sqlite.exec("UPDATE sync_state SET last_error='Successor status'");
    release();
    await expect(oldRun).rejects.toMatchObject({ code: "SYNC_LEASE_LOST" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      importManifest(env, manifest(), "unused", google([]), {
        leaseOwner: oldOwner,
        rowHash: "old-row",
        deadline: Date.now() + 10_000,
      }),
    ).rejects.toThrow();
    expect(count("clips")).toBe(0);
    expect(count("imported_manifests")).toBe(0);
    expect(count("imported_sheet_rows")).toBe(0);
    expect(
      sqlite.prepare("SELECT lease_owner,last_error FROM sync_state").get(),
    ).toMatchObject({
      lease_owner: next.owner,
      last_error: "Successor status",
    });
  });
  it("detects an interrupted lease and stale successful check", async () => {
    await acquireSyncLease(db);
    sqlite.exec(
      "UPDATE sync_state SET lease_expires_at=0,last_success_at='2020-01-01T00:00:00Z'",
    );
    expect((await catalogStatus(env)).sync).toMatchObject({
      running: false,
      stale: true,
    });
    expect((await catalogStatus(env)).sync.lastError).toContain(
      "did not finish",
    );
  });
  it("registers cron work in waitUntil and persists failures", async () => {
    vi.stubGlobal("fetch", google([]));
    const waitUntil = vi.fn();
    worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
      env,
      { waitUntil } as unknown as ExecutionContext,
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect((await catalogStatus(env)).sync.lastSuccessAt).not.toBeNull();
    worker.scheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry() {} },
      { ...env, PRODUCER_SHEET_ID: undefined },
      { waitUntil } as unknown as ExecutionContext,
    );
    await expect(waitUntil.mock.calls[1][0]).rejects.toMatchObject({
      code: "PRODUCER_UNCONFIGURED",
    });
    expect((await catalogStatus(env)).sync.lastError).toContain(
      "not configured",
    );
  });
  it("persists invalid JSON as a safe error without clearing prior data", async () => {
    await pullManifest(env, google([manifest()]));
    await expect(
      pullManifest(env, google(["invalid-json"])),
    ).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    expect(count("clips")).toBe(1);
    expect((await catalogStatus(env)).sync.lastError).toContain(
      "manifest is invalid",
    );
  });
  it("bounds raw response allocation and cancels oversized streams", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(10));
        },
        cancel,
      }),
    );
    await expect(readBoundedText(response, 12)).rejects.toMatchObject({
      code: "IMPORT_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("stops at the deadline and records a recoverable timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const run = pullManifest(env, fetcher);
    const assertion = expect(run).rejects.toMatchObject({
      code: "SYNC_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(SYNC_DEADLINE_MS);
    await assertion;
    expect((await catalogStatus(env)).sync).toMatchObject({ running: false });
    expect((await catalogStatus(env)).sync.lastError).toContain("timed out");
  });
  it("continues bounded partial progress on the next run without advancing last success prematurely", async () => {
    const original = manifest();
    await pullManifest(env, google([original]));
    const success = (await catalogStatus(env)).sync.lastSuccessAt;
    const rows = [
      original,
      ...Array.from({ length: 5 }, (_, i) => ({
        schemaVersion: 1,
        episodes: [],
        clips: [],
        renders: [],
        artifacts: [],
        activations: [],
        events: [
          {
            schemaVersion: 1,
            id: `budget-event-${i}`,
            attemptId: "budget-attempt",
            clipId: "test-clip",
            sequence: i,
            occurredAt: "2026-10-07T00:00:00Z",
            stage: "Fixture",
            state: "working",
            progress: true,
            nextExpectedAt: null,
            blocker: null,
            checkpoint: null,
          },
        ],
      })),
    ];
    await expect(pullManifest(env, google(rows))).rejects.toMatchObject({
      code: "SYNC_BUDGET_REACHED",
    });
    expect(count("producer_events")).toBe(4);
    expect((await catalogStatus(env)).sync.lastSuccessAt).toBe(success);
    expect(await pullManifest(env, google(rows))).toMatchObject({
      imported: 1,
    });
    expect(count("producer_events")).toBe(5);
    expect((await catalogStatus(env)).sync.lastError).toBeNull();
  });
  it("rejects an oversized event-only query workload before validation or media work", async () => {
    const oversized = {
      schemaVersion: 1,
      episodes: [],
      clips: [],
      renders: [],
      artifacts: [],
      activations: [],
      events: Array.from({ length: 500 }, (_, i) => ({
        schemaVersion: 1,
        id: `event-${i}`,
        attemptId: "attempt",
        clipId: "test-clip",
        sequence: i,
        occurredAt: "2026-10-07T00:00:00Z",
        stage: "Fixture",
        state: "working",
        progress: true,
        nextExpectedAt: null,
        blocker: null,
        checkpoint: null,
      })),
    };
    const fetcher = google([oversized]);
    await expect(pullManifest(env, fetcher)).rejects.toMatchObject({
      code: "IMPORT_TOO_LARGE",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(count("producer_events")).toBe(0);
    expect(count("imported_sheet_rows")).toBe(0);
  });
  it("bounds the status index and reports incomplete counts honestly", async () => {
    sqlite.exec(`INSERT INTO episodes(id,data) VALUES('test-episode','{}');
      WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<1001)
      INSERT INTO clips(id,episode_id,data) SELECT 'clip-'||n,'test-episode',json_object('currentRenderId','render-'||n) FROM sequence;`);
    const status = await catalogStatus(env);
    expect(status.complete).toBe(false);
    expect(status.clips).toHaveLength(1000);
  });
  it("never claims a catalog baseline newer than the loaded clip snapshot", async () => {
    await pullManifest(env, google([manifest()]));
    const before = await catalogStatus(env);
    let changed = false;
    const snapshotDB = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT clips.*")) return statement;
          const originalBind = statement.bind.bind(statement);
          statement.bind = (...args: unknown[]) => {
            const bound = originalBind(...args);
            const originalAll = bound.all.bind(bound);
            bound.all = async <T>() => {
              const rows = await originalAll<T>();
              if (!changed) {
                changed = true;
                await pullManifest(env, google([manifest(), manifest(2)]));
              }
              return rows;
            };
            return bound;
          };
          return statement;
        };
      },
    });
    const detail = await getEpisode(snapshotDB, "test-episode");
    expect(detail.catalogVersion).toBe(before.version);
    expect(detail.clips[0].catalogRevision).toBe(before.clips[0].revision);
    expect(detail.clips[0].currentRenderId).toBe("test-render-1");
    expect((await catalogStatus(env)).version).toBeGreaterThan(
      detail.catalogVersion,
    );
  });
});
