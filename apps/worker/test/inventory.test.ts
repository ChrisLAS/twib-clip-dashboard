import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
  INVENTORY_MAX_BYTES,
  INVENTORY_MAX_ITEMS,
  inventoryEpisodeId,
  readInventoryBody,
  semanticHash,
  validateInventory,
  type InventoryGrant,
  type InventoryManifest,
  type InventoryEnvelope,
} from "../src/inventory/contract";
import { acceptInventory, listInventory } from "../src/inventory/store";
import worker from "../src/index";
import type { Env } from "../src/env";
const example = JSON.parse(
  readFileSync(
    new URL("./fixtures/inventory.example.json", import.meta.url),
    "utf8",
  ),
) as InventoryManifest;
const now = Date.parse("2026-10-12T12:00:00Z");
const grant: InventoryGrant = {
  sourceId: "nomad:number-one",
  episodeId: example.episode.id,
  episodeNumber: 127,
  expiresAt: now + 60000,
  scope: "inventory:write",
  allowEditorialContext: true,
  originHosts: ["www.youtube.com", "example.com"],
};
const copy = () => structuredClone(example);
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
beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort())
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
});
const transport = (
  manifest = copy(),
  override: Partial<InventoryEnvelope> = {},
): InventoryEnvelope => ({
  schema: "number-one-inventory-envelope/v2",
  scan_id: "00000000-0000-4000-8000-" + manifest.idempotency_digest.slice(-12),
  sequence: parseInt(manifest.idempotency_digest[7], 16) + 1,
  manifest,
  ...override,
});
const accept = (
  manifest = copy(),
  database = db,
  authorization: InventoryGrant | null = grant,
  override: Partial<InventoryEnvelope> = {},
) => {
  const envelope = transport(manifest, override);
  return acceptInventory(
    database,
    envelope,
    envelope.scan_id,
    authorization,
    now,
  );
};
const count = (table: string) =>
  sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n;
function changed(digit = "a", time = "2026-10-12T10:03:00Z") {
  const manifest = copy();
  manifest.idempotency_digest = "sha256:" + digit.repeat(64);
  manifest.observed_at = time;
  manifest.scan_finished_at = time;
  return manifest;
}
describe("Number One inventory contract", () => {
  it("validates the exact synthetic handoff with the real Draft 2020-12 schema", async () => {
    expect(await inventoryEpisodeId(127)).toBe(example.episode.id);
    expect(
      await validateInventory(copy(), example.idempotency_digest, grant, now),
    ).toEqual(example);
  });
  it.each([
    null,
    { ...grant, expiresAt: now },
    { ...grant, scope: "owner" },
    { ...grant, episodeNumber: 128 },
    { ...grant, episodeId: "episode_" + "f".repeat(64) },
  ])("requires a current exact machine scope", async (authorization) => {
    await expect(
      accept(copy(), db, authorization as InventoryGrant | null),
    ).rejects.toMatchObject({ status: 403 });
    expect(count("inventory_snapshots")).toBe(0);
  });
  it("rejects self-asserted episode identity even when a grant repeats it", async () => {
    const m = copy();
    m.episode.id = "episode_" + "f".repeat(64);
    await expect(
      accept(m, db, { ...grant, episodeId: m.episode.id }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    "unknownField",
    "ready",
    "deletions",
    "wrongKind",
    "date",
    "duplicate",
    "future",
    "reversed",
  ])("rejects schema/semantic violation: %s", async (variant) => {
    const m = copy();
    if (variant === "unknownField")
      Object.assign(m, { credential: "SYNTHETIC" });
    if (variant === "ready") Object.assign(m.items[0], { ready: true });
    if (variant === "deletions")
      Object.assign(m.snapshot, { allow_deletions: true });
    if (variant === "wrongKind") m.items[0].kind = "media";
    if (variant === "date") m.observed_at = "2026-02-30T10:00:00Z";
    if (variant === "duplicate") m.items.push(structuredClone(m.items[0]));
    if (variant === "future") m.scan_finished_at = "2026-10-13T10:00:00Z";
    if (variant === "reversed") m.observed_at = "2026-10-12T11:00:00Z";
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "/private/host/file",
    "../clip.mp4",
    "x/../clip",
    "https://example.com/file",
    "C:media.mp4",
    "a\\b",
    "a\u0000b",
    "%2e%2e/clip",
    "a?token=x",
    "a/%252e%252e/b",
  ])("rejects unsafe relative reference %s", async (ref) => {
    const m = copy();
    m.coverage[0].artifact = ref;
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "http://127.0.0.1./path",
    "http://localhost./path",
    "http://0177.0.0.1/path",
    "http://2130706433/path",
    "http://[::1]/path",
    "https://user:password@example.com/path",
    "https://example.com/path?token=SYNTHETIC",
    "https://example.com/path#fragment",
    "https://example.com:444/path",
    "https://example.com/token%3DSYNTHETIC",
    "https://not-approved.example/path",
  ])("rejects unsafe or unapproved origin %s", async (url) => {
    const m = copy();
    m.items[0].origins[0].url = url;
    await expect(accept(m)).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    "token=SYNTHETIC",
    "Bearer SYNTHETIC",
    "a /private/host/file",
    "C:\\Users\\private",
    "https://example.com/path?private=SYNTHETIC",
  ])(
    "rejects rather than stores recognizable sensitive prose %s",
    async (text) => {
      const m = copy();
      m.items[0].observations[0].context.title = text;
      await expect(accept(m)).rejects.toMatchObject({ status: 422 });
      expect(count("inventory_snapshots")).toBe(0);
    },
  );
  it("requires explicit editorial privacy policy and exact digest header", async () => {
    await expect(
      accept(copy(), db, { ...grant, allowEditorialContext: false }),
    ).rejects.toMatchObject({ code: "INVENTORY_PRIVACY_REVIEW_REQUIRED" });
    await expect(
      validateInventory(copy(), null, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_KEY_MISMATCH" });
  });
  it("enforces item and per-item bounds before persistence", async () => {
    const m = copy();
    m.items = Array(INVENTORY_MAX_ITEMS + 1).fill(m.items[0]);
    await expect(accept(m)).rejects.toMatchObject({ code: "INVENTORY_LIMIT" });
    const huge = copy();
    huge.items[0].observations = Array(100).fill({
      ...huge.items[0].observations[0],
      context: { title: "x".repeat(4000) },
    });
    await expect(accept(huge)).rejects.toMatchObject({
      code: "INVENTORY_LIMIT",
    });
  });
});
describe("durable isolated inventory storage", () => {
  it("accepts the distributed synthetic v2 envelope example", async () => {
    const envelope = JSON.parse(
      readFileSync(
        new URL("./fixtures/inventory.envelope.example.json", import.meta.url),
        "utf8",
      ),
    ) as InventoryEnvelope;
    const receipt = await acceptInventory(
      db,
      envelope,
      envelope.scan_id,
      grant,
      now,
    );
    expect(receipt).toMatchObject({
      schema: "number-one-inventory-receipt/v2",
      scan_id: envelope.scan_id,
      sequence: 1,
      digest: example.idempotency_digest,
    });
  });
  it("returns original receipt for an immutable retry despite property order", async () => {
    const first = await accept();
    const replay = copy();

    replay.items[0].observations[1].context = Object.fromEntries(
      Object.entries(replay.items[0].observations[1].context).reverse(),
    );
    expect(await semanticHash(replay)).toBe(await semanticHash(example));
    expect(await accept(replay)).toEqual(first);
    expect(count("inventory_snapshots")).toBe(1);
    expect(count("inventory_observations")).toBe(1);
  });
  it("orders a fresh A-to-B-to-A scan independently of repeated content digest", async () => {
    const original = await accept();
    const b = changed();
    b.items[0].processing_status = "failed";
    await accept(b);
    const again = copy();
    again.observed_at = "2026-10-12T11:00:00Z";
    again.scan_finished_at = "2026-10-12T11:00:01Z";
    const latest = await accept(again, db, grant, {
      scan_id: "00000000-0000-4000-8000-cccccccccccc",
      sequence: 20,
    });
    expect(latest.digest).toBe(original.digest);
    expect(latest.receipt_id).not.toBe(original.receipt_id);
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe(
      "capture_required",
    );
    expect(view.items[0].variants[0].sequence).toBe(20);
    expect(count("inventory_snapshots")).toBe(3);
  });
  it("rejects digest reuse for changed content without mutation", async () => {
    await accept();
    const m = copy();
    m.items[0].processing_status = "failed";
    await expect(
      accept(m, db, grant, {
        scan_id: "00000000-0000-4000-8000-cccccccccccc",
        sequence: 20,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "INVENTORY_DIGEST_CONFLICT",
    });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("rejects mutation of scan timestamps or sequence on a retry", async () => {
    await accept();
    const m = copy();
    m.scan_finished_at = "2026-10-12T10:02:02Z";
    expect(await semanticHash(m)).toBe(await semanticHash(example));
    await expect(accept(m)).rejects.toMatchObject({
      code: "INVENTORY_SCAN_CONFLICT",
    });
    await expect(
      accept(copy(), db, grant, { sequence: 2 }),
    ).rejects.toMatchObject({ code: "INVENTORY_SCAN_CONFLICT" });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("rejects duplicate sequences with a different scan ID", async () => {
    await accept();
    await expect(
      accept(copy(), db, grant, {
        scan_id: "00000000-0000-4000-8000-cccccccccccc",
      }),
    ).rejects.toMatchObject({ code: "INVENTORY_SEQUENCE_CONFLICT" });
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("uses sequence when the source clock moves backwards and permits gaps", async () => {
    await accept();
    const m = changed("b", "2026-10-12T09:00:00Z");
    m.items[0].processing_status = "failed";
    await accept(m, db, grant, { sequence: 100 });
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(view.items[0].variants[0].sequence).toBe(100);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid sequence %s",
    async (sequence) => {
      await expect(
        accept(copy(), db, grant, { sequence }),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
  it("requires exact envelope fields, UUIDv4 and scan-ID header", async () => {
    const envelope = transport();
    await expect(
      acceptInventory(
        db,
        { ...envelope, extra: true },
        envelope.scan_id,
        grant,
        now,
      ),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
    await expect(
      accept(copy(), db, grant, { scan_id: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
    await expect(
      acceptInventory(db, envelope, example.idempotency_digest, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_KEY_MISMATCH" });
    await expect(
      acceptInventory(db, copy(), example.idempotency_digest, grant, now),
    ).rejects.toMatchObject({ code: "INVENTORY_ENVELOPE_INVALID" });
  });
  it("retains absent items on both complete and partial snapshots", async () => {
    await accept();
    const partial = changed();
    partial.items = [];
    partial.snapshot.complete = false;
    await accept(partial);
    const complete = changed("b");
    complete.items = [];
    await accept(complete);
    const view = await listInventory(db, example.episode.id);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].variants[0].item).toEqual(example.items[0]);
    expect(count("inventory_snapshots")).toBe(3);
  });
  it("retains history without letting late older snapshots roll back an item", async () => {
    const newer = changed();
    newer.items[0].processing_status = "failed";
    await accept(newer);
    await accept();
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(count("inventory_observations")).toBe(2);
  });
  it("orders equal-time scans by sequence and marks no item playable", async () => {
    await accept();
    const m = changed("b", example.observed_at);
    m.items[0].processing_status = "failed";
    await accept(m);
    const view = await listInventory(db, example.episode.id);
    expect(view.items[0].conflictingLatestObservations).toBe(false);
    expect(view.items[0].variants).toHaveLength(1);
    expect(view.items[0].variants[0].item.processing_status).toBe("failed");
    expect(view.items[0].readiness).toBe("not_evaluated");
    expect(view.items[0].variants.every((v) => v.item.ready === false)).toBe(
      true,
    );
    expect(count("clips")).toBe(0);
    expect(count("renders")).toBe(0);
  });
  it("rolls back receipt and identities if observation storage fails", async () => {
    sqlite.exec(
      "CREATE TRIGGER inventory_fail BEFORE INSERT ON inventory_observations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    await expect(accept()).rejects.toThrow();
    expect(count("inventory_snapshots")).toBe(0);
    expect(count("inventory_items")).toBe(0);
    expect(count("inventory_observations")).toBe(0);
  });
  it("recovers a matching durable receipt after an uncertain batch response", async () => {
    const uncertain = {
      ...db,
      batch: async (statements: D1PreparedStatement[]) => {
        await db.batch(statements);
        throw new Error("lost response");
      },
    } as unknown as D1Database;
    const receipt = await accept(copy(), uncertain);
    expect(receipt.digest).toBe(example.idempotency_digest);
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("handles competing submissions atomically", async () => {
    const [a, b] = await Promise.all([accept(), accept()]);
    expect(a).toEqual(b);
    expect(count("inventory_snapshots")).toBe(1);
  });
  it("does not mix episode reads", async () => {
    await accept();
    expect(
      (await listInventory(db, await inventoryEpisodeId(128))).items,
    ).toEqual([]);
  });
  it("paginates inventory without missing or duplicating identities", async () => {
    const m = copy();
    m.items = Array.from({ length: 23 }, (_, i) => ({
      ...structuredClone(m.items[0]),
      id: "item_" + i.toString(16).padStart(64, "0"),
    }));
    await accept(m);
    const first = await listInventory(db, m.episode.id);
    expect(first.items).toHaveLength(20);
    const second = await listInventory(db, m.episode.id, first.nextCursor);
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(23);
  });
});
describe("HTTP fail-closed boundary", () => {
  it.each(["POST", "GET", "OPTIONS"])(
    "never accepts owner, demo, or bearer authentication for producer %s",
    async (method) => {
      const prepare = vi.fn(() => {
        throw new Error("must not touch DB");
      });
      const env = {
        APP_ENV: "local",
        LOCAL_DEMO: "true",
        DB: { prepare },
      } as unknown as Env;
      const response = await worker.fetch(
        new Request("http://localhost/api/v1/number-one/inventory-snapshots", {
          method,
          headers: {
            Authorization: "Bearer SYNTHETIC",
            "Cf-Access-Jwt-Assertion": "SYNTHETIC",
          },
        }),
        env,
      );
      expect(response.status).toBe(503);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("INVENTORY_INGESTION_DISABLED");
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  it("keeps the proposed v2 transport route disabled", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/v2/number-one/inventory-snapshots", {
        method: "POST",
      }),
      { APP_ENV: "local" } as Env,
    );
    expect(response.status).toBe(503);
  });
  it("keeps owner inventory reads behind authentication", async () => {
    const response = await worker.fetch(
      new Request(
        "https://example.com/api/inventory?episodeId=" + example.episode.id,
      ),
      { APP_ENV: "production", DB: db } as Env,
    );
    expect(response.status).toBe(503);
  });
  it("rejects a missing owner JWT with configured Access before reading inventory", async () => {
    const prepare = vi.fn(() => {
      throw new Error("must not touch DB");
    });
    const env = {
      APP_ENV: "production",
      APP_ORIGIN: "https://example.com",
      ACCESS_TEAM_DOMAIN: "synthetic.cloudflareaccess.com",
      ACCESS_AUD: "synthetic-audience",
      OWNER_EMAIL: "owner@example.com",
      DB: { prepare },
    } as unknown as Env;
    const response = await worker.fetch(
      new Request(
        "https://example.com/api/inventory?episodeId=" + example.episode.id,
      ),
      env,
    );
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("bounds streamed JSON even without Content-Length", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(INVENTORY_MAX_BYTES + 1));
        controller.close();
      },
    });
    const request = new Request("https://example.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readInventoryBody(request)).rejects.toMatchObject({
      status: 413,
    });
  });
  it("rejects malformed UTF-8 and compressed/non-JSON requests", async () => {
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: new Uint8Array([0xff]),
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readInventoryBody(
        new Request("https://example.com", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
          },
          body: "{}",
        }),
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
